package main

import (
	"context"
	"encoding/json"
	"os"
	"sort"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/sirupsen/logrus"
	"gorm.io/gorm"
)

var (
	jobCancellersMu sync.Mutex
	jobCancellers   = make(map[string]context.CancelFunc)

	reOcrCancellersMu sync.Mutex
	reOcrCancellers   = make(map[string]context.CancelFunc)

	// skipPages tracks pages to skip per job: jobID -> set of page indices (0-based)
	skipPagesMu sync.Mutex
	skipPages   = make(map[string]map[int]bool)
)

// Job represents an OCR job
type Job struct {
	ID         string
	DocumentID int
	Status     string // "pending", "in_progress", "completed", "failed", "cancelled"
	Result     string // OCR result (combined text) or error message
	CreatedAt  time.Time
	UpdatedAt  time.Time
	PagesDone  int        // Number of pages processed
	TotalPages int        // Total number of pages in the document
	Options    OCROptions // OCR processing options
}

// JobStore manages jobs and their statuses
type JobStore struct {
	sync.RWMutex
	jobs map[string]*Job
	db   *gorm.DB
}

var (
	logger = logrus.New()

	jobStore = &JobStore{
		jobs: make(map[string]*Job),
	}
	jobQueue = make(chan *Job, 100) // Buffered channel with capacity of 100 jobs
)

func init() {
	logger.SetOutput(os.Stdout)
	logger.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
	})
	logger.SetLevel(logrus.InfoLevel)
	logger.WithField("prefix", "OCR_JOB")
}

func generateJobID() string {
	return uuid.New().String()
}

// persistJob writes the job state to the database
func (store *JobStore) persistJob(job *Job) {
	if store.db == nil {
		return
	}
	record := OCRJobRecord{
		ID:         job.ID,
		DocumentID: job.DocumentID,
		Status:     job.Status,
		Result:     job.Result,
		PagesDone:  job.PagesDone,
		TotalPages: job.TotalPages,
		CreatedAt:  job.CreatedAt,
		UpdatedAt:  job.UpdatedAt,
	}
	store.db.Save(&record)
}

// loadJobsFromDB loads all jobs from the database into memory
func (store *JobStore) loadJobsFromDB() {
	if store.db == nil {
		return
	}
	var records []OCRJobRecord
	store.db.Order("created_at DESC").Find(&records)

	store.Lock()
	defer store.Unlock()
	for _, r := range records {
		// Mark any in_progress/pending jobs as failed (server restarted)
		status := r.Status
		result := r.Result
		if status == "in_progress" || status == "pending" {
			status = "failed"
			result = "Server restarted while job was running"
		}
		store.jobs[r.ID] = &Job{
			ID:         r.ID,
			DocumentID: r.DocumentID,
			Status:     status,
			Result:     result,
			PagesDone:  r.PagesDone,
			TotalPages: r.TotalPages,
			CreatedAt:  r.CreatedAt,
			UpdatedAt:  r.UpdatedAt,
		}
	}
	logger.Infof("Loaded %d jobs from database", len(records))
}

func (store *JobStore) addJob(job *Job) {
	store.Lock()
	defer store.Unlock()
	job.PagesDone = 0
	store.jobs[job.ID] = job
	store.persistJob(job)
	logger.Infof("Job added: %v", job)
}

func (store *JobStore) getJob(jobID string) (*Job, bool) {
	store.RLock()
	defer store.RUnlock()
	job, exists := store.jobs[jobID]
	return job, exists
}

func (store *JobStore) GetAllJobs() []*Job {
	store.RLock()
	defer store.RUnlock()

	jobs := make([]*Job, 0, len(store.jobs))
	for _, job := range store.jobs {
		jobs = append(jobs, job)
	}

	sort.Slice(jobs, func(i, j int) bool {
		return jobs[i].CreatedAt.After(jobs[j].CreatedAt)
	})

	return jobs
}

func (store *JobStore) updateJobStatus(jobID, status, result string) {
	store.Lock()
	defer store.Unlock()
	if job, exists := store.jobs[jobID]; exists {
		job.Status = status
		if result != "" {
			job.Result = result
		}
		job.UpdatedAt = time.Now()
		store.persistJob(job)
		logger.Infof("Job status updated: %s -> %s", jobID, status)
	}
}

func (store *JobStore) updatePagesDone(jobID string, pagesDone int) {
	store.Lock()
	defer store.Unlock()
	if job, exists := store.jobs[jobID]; exists {
		job.PagesDone = pagesDone
		job.UpdatedAt = time.Now()
		store.persistJob(job)
	}
}

func markPageSkipped(jobID string, pageIdx int) {
	skipPagesMu.Lock()
	defer skipPagesMu.Unlock()
	if skipPages[jobID] == nil {
		skipPages[jobID] = make(map[int]bool)
	}
	skipPages[jobID][pageIdx] = true
}

func isPageSkipped(jobID string, pageIdx int) bool {
	skipPagesMu.Lock()
	defer skipPagesMu.Unlock()
	return skipPages[jobID] != nil && skipPages[jobID][pageIdx]
}

func cleanupSkipPages(jobID string) {
	skipPagesMu.Lock()
	defer skipPagesMu.Unlock()
	delete(skipPages, jobID)
}

func startWorkerPool(app *App, numWorkers int) {
	for i := 0; i < numWorkers; i++ {
		go func(workerID int) {
			logger.Infof("Worker %d started", workerID)
			for job := range jobQueue {
				logger.Infof("Worker %d processing job: %s", workerID, job.ID)
				processJob(app, job)
			}
		}(i)
	}
}

func processJob(app *App, job *Job) {
	jobStore.updateJobStatus(job.ID, "in_progress", "")

	jobCtx, cancel := context.WithCancel(context.Background())
	jobCancellersMu.Lock()
	jobCancellers[job.ID] = cancel
	jobCancellersMu.Unlock()
	defer func() {
		cancel()
		jobCancellersMu.Lock()
		delete(jobCancellers, job.ID)
		jobCancellersMu.Unlock()
	}()

	// Delete old OCR page results for this document before starting new OCR
	if err := DeleteOcrPageResults(app.Database, job.DocumentID); err != nil {
		logger.Errorf("Failed to delete old OCR page results for document %d: %v", job.DocumentID, err)
	}

	// Create OCR options: use job options, fill in app defaults for upload settings
	options := job.Options
	if !options.UploadPDF && app.pdfUpload {
		options.UploadPDF = app.pdfUpload
		options.ReplaceOriginal = app.pdfReplace
		options.CopyMetadata = app.pdfCopyMetadata
	}
	// LimitPages=0 means no limit (process all pages); only use global default for background jobs
	if options.LimitPages < 0 {
		options.LimitPages = limitOcrPages
	}

	processedDoc, err := app.ProcessDocumentOCR(jobCtx, job.DocumentID, options, job.ID)
	defer cleanupSkipPages(job.ID)
	if err != nil {
		if jobCtx.Err() == context.Canceled {
			jobStore.updateJobStatus(job.ID, "cancelled", "Job cancelled by user")
			logger.Infof("Job cancelled: %s", job.ID)
		} else {
			logger.Errorf("Error processing document OCR for job %s: %v", job.ID, err)
			jobStore.updateJobStatus(job.ID, "failed", err.Error())
		}
		return
	}
	if processedDoc == nil {
		logger.Infof("OCR processing skipped for job %s (document %d)", job.ID, job.DocumentID)
		jobStore.updateJobStatus(job.ID, "completed", "Skipped (already processed or other reason)")
		return
	}

	// Build structured result with per-page results from DB
	type pageResult struct {
		Text        string                 `json:"text"`
		OcrLimitHit bool                   `json:"ocrLimitHit"`
		GenInfo     map[string]interface{} `json:"generationInfo,omitempty"`
	}
	dbResults, _ := GetOcrPageResults(app.Database, job.DocumentID)
	perPage := make([]pageResult, 0, len(dbResults))
	for _, r := range dbResults {
		pr := pageResult{Text: r.Text, OcrLimitHit: r.OcrLimitHit}
		if r.GenerationInfo != "" {
			_ = json.Unmarshal([]byte(r.GenerationInfo), &pr.GenInfo)
		}
		perPage = append(perPage, pr)
	}
	structured, _ := json.Marshal(map[string]interface{}{
		"combinedText":   processedDoc.Text,
		"perPageResults": perPage,
	})

	jobStore.updateJobStatus(job.ID, "completed", string(structured))
	logger.Infof("Job completed: %s", job.ID)
}
