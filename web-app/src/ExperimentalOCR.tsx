import axios from 'axios';
import React, { useCallback, useEffect, useState, useRef } from 'react';
import { FaSpinner } from 'react-icons/fa';
import { Document, DocumentSuggestion } from './DocumentProcessor';
import { Tooltip } from 'react-tooltip';
import { ClientStatus, OCRJobStatus, getStatusViewOptions, mapJobStatus } from './ocrStatus';

const formatElapsed = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
  }
  return `${seconds}s`;
};

type OCRPageResult = {
  text: string;
  ocrLimitHit: boolean;
  generationInfo?: Record<string, any>;
};
type OCRCombinedResult = { combinedText: string; perPageResults: OCRPageResult[] };

type SearchResult = {
  id: number;
  title: string;
  created_date: string;
  original_file_name: string;
  added: string;
};

const ExperimentalOCR: React.FC = () => {
  const refreshInterval = 1000; // Refresh interval in milliseconds
  const [documentId, setDocumentId] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchTotal, setSearchTotal] = useState(0);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showPicker, setShowPicker] = useState(true);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [jobId, setJobId] = useState('');
  const [ocrResult, setOcrResult] = useState('');
  const [jobStatus, setJobStatus] = useState<OCRJobStatus>('idle');
  const [clientStatus, setClientStatus] = useState<ClientStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pagesDone, setPagesDone] = useState(0);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [documentDetails, setDocumentDetails] = useState<Document | null>(null);
  const [perPageResults, setPerPageResults] = useState<OCRPageResult[]>([]);
  const lastFetchedPagesDoneRef = useRef(0);

  const [reOcrLoading, setReOcrLoading] = useState<{ [pageIdx: number]: boolean }>({});
  const [reOcrErrors, setReOcrErrors] = useState<{ [pageIdx: number]: string }>({});
  const [reOcrAbortControllers, setReOcrAbortControllers] = useState<{ [pageIdx: number]: AbortController | null }>({});
  const [skippedPages, setSkippedPages] = useState<Set<number>>(new Set());

  const [elapsedMs, setElapsedMs] = useState(0);
  const [finalElapsedMs, setFinalElapsedMs] = useState<number | null>(null);
  const timerStartRef = useRef<number | null>(null);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const searchDocuments = useCallback(async (query: string) => {
    setSearchLoading(true);
    try {
      const params = new URLSearchParams({ page_size: '20' });
      if (query.trim()) params.set('q', query.trim());
      const response = await axios.get(`./api/search-documents?${params}`);
      setSearchResults(response.data.results || []);
      setSearchTotal(response.data.count || 0);
    } catch {
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, []);

  // Load documents on mount
  useEffect(() => {
    searchDocuments('');
  }, [searchDocuments]);

  // Debounced search
  useEffect(() => {
    if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    searchTimeoutRef.current = setTimeout(() => {
      searchDocuments(searchQuery);
    }, 300);
    return () => {
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
    };
  }, [searchQuery, searchDocuments]);

  const selectDocument = (doc: SearchResult) => {
    setDocumentId(doc.id);
    setShowPicker(false);
  };

  const handleSkipPage = async (pageIdx: number) => {
    if (!jobId) return;
    try {
      await axios.post(`./api/ocr/jobs/${jobId}/skip-page/${pageIdx}`);
      setSkippedPages((prev) => new Set(prev).add(pageIdx));
    } catch {
      // ignore
    }
  };

  const stopOCRJob = async () => {
    if (!jobId) return;
    try {
      await axios.post(`./api/ocr/jobs/${jobId}/stop`);
      stopTimer();
      setJobStatus('cancelled');
    } catch (err) {
      setError('Failed to stop OCR job.');
    }
  };

  useEffect(() => {
    return () => {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    };
  }, []);

  const fetchDocumentDetails = useCallback(async () => {
    if (!documentId) return;

    try {
      const response = await axios.get<Document>(`./api/documents/${documentId}`);
      setDocumentDetails(response.data);
    } catch (err) {
      console.error("Error fetching document details:", err);
      setError("Failed to fetch document details.");
    }
  }, [documentId]);

  const fetchPerPageResults = useCallback(async () => {
    if (!documentId) return;
    try {
      const response = await axios.get<{ pages: OCRPageResult[] }>(`./api/documents/${documentId}/ocr_pages`);
      setPerPageResults(response.data.pages);
    } catch (err) {
      console.error("Error fetching per-page OCR results:", err);
      setError("Failed to fetch per-page OCR results.");
    }
  }, [documentId]);

  const startTimer = () => {
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    timerStartRef.current = Date.now();
    setElapsedMs(0);
    setFinalElapsedMs(null);
    timerIntervalRef.current = setInterval(() => {
      if (timerStartRef.current) {
        setElapsedMs(Date.now() - timerStartRef.current);
      }
    }, 1000);
  };

  const stopTimer = () => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (timerStartRef.current) {
      setFinalElapsedMs(Date.now() - timerStartRef.current);
      timerStartRef.current = null;
    }
  };

  const submitOCRJob = async () => {
    setError(null);
    setMessage(null);
    setJobId('');
    setOcrResult('');
    setPagesDone(0);
    setPerPageResults([]);
    setJobStatus('idle');
    setClientStatus('fetching_details');
    lastFetchedPagesDoneRef.current = 0;
    setSkippedPages(new Set());

    try {
      await fetchDocumentDetails();

      setClientStatus('submitting');
      startTimer();
      const response = await axios.post(`./api/documents/${documentId}/ocr`);
      setJobId(response.data.job_id);
      setJobStatus('pending');
      setClientStatus('idle');
    } catch (err) {
      console.error(err);
      setError('Failed to submit OCR job.');
      setClientStatus('idle');
    }
  };

  const checkJobStatus = async () => {
    if (!jobId) return;

    try {
      const response = await axios.get(`./api/jobs/ocr/${jobId}`);
      const newJobStatus = mapJobStatus(response.data.status);
      setJobStatus(newJobStatus);
      const newPagesDone = response.data.pages_done;
      setPagesDone(newPagesDone);
      setTotalPages(response.data.total_pages ?? null);

      if (newPagesDone > lastFetchedPagesDoneRef.current) {
        await fetchPerPageResults();
        lastFetchedPagesDoneRef.current = newPagesDone;
      }

      if (newJobStatus === 'completed') {
        stopTimer();
        let parsedResult: OCRCombinedResult | null = null;
        try {
          parsedResult = JSON.parse(response.data.result);
        } catch (e) {
          setOcrResult(response.data.result);
          return;
        }
        if (parsedResult) {
          setOcrResult(parsedResult.combinedText);
          setPerPageResults(parsedResult.perPageResults);
        }
      } else if (newJobStatus === 'failed') {
        stopTimer();
        setError(response.data.error);
      } else {
        setTimeout(() => checkJobStatus(), refreshInterval);
      }
    } catch (err) {
      console.error(err);
      setError('Failed to check job status.');
    }
  };

  const handleSaveContent = async () => {
    setSaving(true);
    setError(null);
    try {
      if (!documentDetails) {
        setError('Document details not fetched.');
        throw new Error('Document details not fetched.');
      }
      const requestPayload: DocumentSuggestion = {
        id: documentId,
        original_document: documentDetails,
        suggested_content: ocrResult,
      };

      await axios.patch("./api/update-documents", [requestPayload]);
      setMessage('Content saved successfully.');
    } catch (err) {
      console.error("Error saving content:", err);
      setError("Failed to save content.");
    } finally {
      setSaving(false);
    }
  };

  const handleReOcrPage = async (pageIdx: number) => {
    if (!perPageResults[pageIdx]) {
      setReOcrErrors((prev) => ({ ...prev, [pageIdx]: "Page data not available." }));
      return;
    }

    setReOcrLoading((prev) => ({ ...prev, [pageIdx]: true }));
    setReOcrErrors((prev) => ({ ...prev, [pageIdx]: "" }));

    const controller = new AbortController();
    setReOcrAbortControllers((prev) => ({ ...prev, [pageIdx]: controller }));

    try {
      const response = await axios.post(
        `./api/documents/${documentId}/ocr_pages/${pageIdx}/reocr`,
        {},
        { signal: controller.signal }
      );

      setPerPageResults((prev) =>
        prev.map((res, idx) =>
          idx === pageIdx
            ? {
                text: response.data.text,
                ocrLimitHit: response.data.ocrLimitHit,
                generationInfo: response.data.generationInfo,
              }
            : res
        )
      );

      if (pageIdx + 1 > lastFetchedPagesDoneRef.current) {
        lastFetchedPagesDoneRef.current = pageIdx + 1;
      }
    } catch (err: any) {
      if (err.name === 'CanceledError' || err.code === 'ERR_CANCELED') {
        setReOcrErrors((prev) => ({
          ...prev,
          [pageIdx]: "Re-OCR cancelled.",
        }));
      } else {
        setReOcrErrors((prev) => ({
          ...prev,
          [pageIdx]: "Failed to re-OCR page.",
        }));
      }
    } finally {
      setReOcrLoading((prev) => ({ ...prev, [pageIdx]: false }));
      setReOcrAbortControllers((prev) => ({ ...prev, [pageIdx]: null }));
    }
  };

  const handleCancelReOcrPage = async (pageIdx: number) => {
    const controller = reOcrAbortControllers[pageIdx];
    if (controller) {
      controller.abort();
    }

    try {
      await axios.delete(`./api/documents/${documentId}/ocr_pages/${pageIdx}/reocr`);
      console.log(`Cancellation request sent for page ${pageIdx}`);
    } catch (err) {
      console.error(`Failed to send cancellation request for page ${pageIdx}:`, err);
    }
  };

  useEffect(() => {
    if (jobId) {
      lastFetchedPagesDoneRef.current = 0;
      checkJobStatus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const statusViewOptions = getStatusViewOptions(jobStatus, clientStatus);

  return (
    <div className="max-w-3xl mx-auto p-6 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200">
      <h1 className="text-4xl font-bold mb-6 text-center">OCR via LLMs (Experimental)</h1>
      <p className="mb-6 text-center text-yellow-600">
        This is an experimental feature. Results may vary, and processing may take some time.
      </p>
      <div className="bg-gray-100 dark:bg-gray-800 p-6 rounded-lg shadow-md">
        {/* Document Picker */}
        <div className="mb-4">
          {documentId > 0 && !showPicker ? (
            <div className="flex items-center justify-between bg-white dark:bg-gray-700 rounded-lg p-3 border border-gray-300 dark:border-gray-600">
              <div className="flex items-center gap-3">
                <img
                  src={`./api/document-thumbnail/${documentId}`}
                  alt="thumbnail"
                  className="w-12 h-16 object-cover rounded border border-gray-200 dark:border-gray-600"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
                <div>
                  <span className="font-semibold text-gray-800 dark:text-gray-200">
                    Document #{documentId}
                  </span>
                  {searchResults.find(d => d.id === documentId) && (
                    <p className="text-sm text-gray-500 dark:text-gray-400 truncate max-w-md">
                      {searchResults.find(d => d.id === documentId)?.title}
                    </p>
                  )}
                </div>
              </div>
              <button
                onClick={() => setShowPicker(true)}
                className="text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 font-medium"
              >
                Change
              </button>
            </div>
          ) : (
            <>
              <label className="block mb-2 font-semibold">Select a document:</label>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="border border-gray-300 dark:border-gray-700 rounded w-full p-2 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-3 bg-white dark:bg-gray-700"
                placeholder="Search documents by title..."
              />
              {searchLoading ? (
                <div className="flex items-center justify-center py-8 text-gray-500">
                  <FaSpinner className="animate-spin mr-2" /> Loading documents...
                </div>
              ) : searchResults.length === 0 ? (
                <div className="text-center py-8 text-gray-500">No documents found.</div>
              ) : (
                <>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                    Showing {searchResults.length} of {searchTotal} documents
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 max-h-80 overflow-y-auto">
                    {searchResults.map((doc) => (
                      <button
                        key={doc.id}
                        onClick={() => selectDocument(doc)}
                        className={`flex flex-col items-center p-2 rounded-lg border transition-all duration-150 hover:shadow-md hover:border-blue-500 ${
                          documentId === doc.id
                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30'
                            : 'border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700'
                        }`}
                      >
                        <img
                          src={`./api/document-thumbnail/${doc.id}`}
                          alt={doc.title}
                          className="w-full h-24 object-cover rounded mb-2 bg-gray-200 dark:bg-gray-600"
                          onError={(e) => {
                            const img = e.target as HTMLImageElement;
                            img.style.display = 'none';
                          }}
                        />
                        <span className="text-xs font-medium text-gray-800 dark:text-gray-200 text-center line-clamp-2 w-full">
                          {doc.title}
                        </span>
                        <span className="text-xs text-gray-400 mt-1">#{doc.id}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
        <button
          onClick={submitOCRJob}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded transition duration-200"
          disabled={!documentId}
        >
          {clientStatus === 'submitting' ? (
            <span className="flex items-center justify-center">
              <FaSpinner className="animate-spin mr-2" />
              Submitting...
            </span>
          ) : (
            'Submit OCR Job'
          )}
        </button>
        {(statusViewOptions.label || pagesDone > 0) && (
          <div className="mt-4">
            {/* Status header row */}
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center text-gray-700 dark:text-gray-300">
                {statusViewOptions.showSpinner && (
                  <FaSpinner className="animate-spin mr-2 text-blue-500" />
                )}
                <span className="font-medium">{statusViewOptions.label}</span>
              </div>
              {(timerStartRef.current || finalElapsedMs) && (
                <span className="text-sm font-mono text-gray-500 dark:text-gray-400 tabular-nums">
                  {finalElapsedMs
                    ? `${formatElapsed(finalElapsedMs)}`
                    : formatElapsed(elapsedMs)}
                </span>
              )}
            </div>

            {/* Progress bar */}
            {totalPages && totalPages > 0 && (jobStatus === 'in_progress' || jobStatus === 'completed' || jobStatus === 'failed') && (
              <div className="mb-3">
                <div className="flex justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
                  <span>Page {pagesDone} of {totalPages}</span>
                  <span>{totalPages > 0 ? Math.round((pagesDone / totalPages) * 100) : 0}%</span>
                </div>
                <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2.5 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ease-out ${
                      jobStatus === 'failed' ? 'bg-yellow-500' :
                      jobStatus === 'completed' ? 'bg-green-500' : 'bg-blue-500'
                    }`}
                    style={{ width: `${totalPages > 0 ? (pagesDone / totalPages) * 100 : 0}%` }}
                  />
                </div>
              </div>
            )}

            {jobId && statusViewOptions.canStop && (
              <div className="text-center">
                <button
                  onClick={stopOCRJob}
                  className="bg-red-600 hover:bg-red-700 text-white font-semibold py-2 px-4 rounded transition duration-200"
                >
                  Stop Job
                </button>
              </div>
            )}
          </div>
        )}
        {error && (
          <div className="mt-4 p-4 bg-red-100 dark:bg-red-800 text-red-700 dark:text-red-200 rounded">
            {error}
          </div>
        )}
        {message && (
          <div className="mt-4 p-4 bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 rounded">
            {message}
          </div>
        )}
        {perPageResults.length > 0 && (
          <div className="mt-6">
            <h2 className="text-2xl font-bold mb-4">
              Per-Page OCR Results
              {totalPages && <span className="text-base font-normal text-gray-500 ml-2">({perPageResults.length}{totalPages > perPageResults.length ? ` of ${totalPages}` : ''} pages)</span>}
            </h2>
            {perPageResults.map((page, idx) => {
              const isError = page.text.startsWith('[Error:') || page.text.startsWith('[Page ');
              const isSkipped = page.text.includes('skipped');
              // Extract the actual error reason from the text
              const errorMatch = page.text.match(/\[Error:.*?:\s*(.+)\]$/s);
              const errorReason = errorMatch ? errorMatch[1].trim() : page.text;
              return (
              <div key={idx} className={`mb-4 border rounded-lg p-4 ${
                isSkipped
                  ? 'border-yellow-300 dark:border-yellow-700 bg-yellow-50 dark:bg-yellow-900/20'
                  : isError
                    ? 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20'
                    : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900'
              }`}>
                <div className="flex items-center mb-2">
                  <span className={`inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold mr-2 ${
                    isSkipped
                      ? 'bg-yellow-200 text-yellow-800 dark:bg-yellow-800 dark:text-yellow-200'
                      : isError
                        ? 'bg-red-200 text-red-800 dark:bg-red-800 dark:text-red-200'
                        : 'bg-green-200 text-green-800 dark:bg-green-800 dark:text-green-200'
                  }`}>
                    {idx + 1}
                  </span>
                  <span className="font-semibold mr-2">Page {idx + 1}</span>
                  {isSkipped && (
                    <span className="ml-1 px-2 py-0.5 bg-yellow-200 text-yellow-800 rounded text-xs font-bold">
                      Skipped
                    </span>
                  )}
                  {isError && !isSkipped && (
                    <span className="ml-1 px-2 py-0.5 bg-red-200 text-red-800 rounded text-xs font-bold">
                      Failed
                    </span>
                  )}
                  {page.ocrLimitHit && (
                    <span className="ml-2 px-2 py-1 bg-yellow-200 text-yellow-800 rounded text-xs font-bold">
                      Token Limit Hit
                    </span>
                  )}
                  {page.generationInfo && Object.keys(page.generationInfo).length > 0 && (
                    <>
                      <span
                        data-tooltip-id={`geninfo-tooltip-${idx}`}
                        className="ml-3 cursor-pointer text-blue-600 hover:text-blue-800"
                        tabIndex={0}
                        aria-label="Show Generation Info"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="inline-block" width="18" height="18" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-12.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM9 9.25A1 1 0 0110 8.5h.01a1 1 0 01.99 1v4a1 1 0 01-2 0v-4z"/>
                        </svg>
                      </span>
                      <Tooltip
                        id={`geninfo-tooltip-${idx}`}
                        place="top"
                        className="!max-w-xs !text-xs"
                        style={{ zIndex: 9999 }}
                        clickable={true}
                        render={() => (
                          <div className="p-1">
                            <table>
                              <tbody>
                                {Object.entries(page.generationInfo ?? {}).map(([key, value]) => (
                                  <tr key={key}>
                                    <td className="pr-2 font-semibold align-top">{key}:</td>
                                    <td className="break-all">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      />
                    </>
                  )}
                </div>
                {isError && !isSkipped ? (
                  <div className="bg-red-100 dark:bg-red-900/40 border border-red-200 dark:border-red-800 rounded p-3 text-sm">
                    <span className="font-semibold text-red-700 dark:text-red-300 block mb-1">Ollama Error:</span>
                    <code className="text-red-600 dark:text-red-400 text-xs break-all">{errorReason}</code>
                  </div>
                ) : isSkipped ? (
                  <div className="text-sm text-yellow-600 dark:text-yellow-400 italic">Page was skipped by user.</div>
                ) : (
                  <pre className="whitespace-pre-wrap bg-gray-50 dark:bg-gray-800 p-2 rounded border border-gray-200 dark:border-gray-700 overflow-auto max-h-48">
                    {page.text}
                  </pre>
                )}
                <div className="mt-2 flex flex-col sm:flex-row items-start sm:items-center gap-2">
                  <div className="flex flex-row items-center gap-2">
                    <button
                      onClick={() => handleReOcrPage(idx)}
                      className="bg-orange-600 hover:bg-orange-700 text-white font-semibold py-2 px-4 rounded transition duration-200"
                      disabled={reOcrLoading[idx]}
                    >
                      {reOcrLoading[idx] ? (
                        <span className="flex items-center">
                          <FaSpinner className="animate-spin mr-2" />
                          Re-OCRing...
                        </span>
                      ) : (
                        'Re-OCR Page'
                      )}
                    </button>
                    {reOcrLoading[idx] && (
                      <button
                        onClick={() => handleCancelReOcrPage(idx)}
                        className="bg-gray-500 hover:bg-gray-700 text-white font-semibold py-2 px-4 rounded transition duration-200"
                        style={{ marginLeft: 8 }}
                      >
                        Cancel Re-OCR
                      </button>
                    )}
                  </div>
                  {reOcrErrors[idx] && (
                    <span className="text-red-600 text-sm ml-2">{reOcrErrors[idx]}</span>
                  )}
                </div>
              </div>
              );
            })}
            {/* Show upcoming pages queue during processing */}
            {jobStatus === 'in_progress' && totalPages && perPageResults.length < totalPages && (
              <div className="space-y-2">
                {Array.from({ length: Math.min(totalPages - perPageResults.length, 5) }, (_, i) => {
                  const pageIdx = perPageResults.length + i;
                  const isCurrentPage = i === 0;
                  const isSkipped = skippedPages.has(pageIdx);
                  return (
                    <div
                      key={pageIdx}
                      className={`flex items-center justify-between py-3 px-4 rounded-lg border ${
                        isCurrentPage
                          ? 'border-blue-300 dark:border-blue-600 bg-blue-50 dark:bg-blue-900/20'
                          : 'border-dashed border-gray-300 dark:border-gray-600'
                      }`}
                    >
                      <div className="flex items-center text-gray-500 dark:text-gray-400">
                        {isCurrentPage ? (
                          <FaSpinner className="animate-spin mr-2 text-blue-500" />
                        ) : (
                          <span className="w-4 mr-2 text-center text-gray-300">-</span>
                        )}
                        <span className={isCurrentPage ? 'font-medium text-blue-700 dark:text-blue-300' : ''}>
                          Page {pageIdx + 1}
                          {isCurrentPage && ' — processing...'}
                          {isSkipped && ' — will be skipped'}
                        </span>
                      </div>
                      {!isCurrentPage && !isSkipped && (
                        <button
                          onClick={() => handleSkipPage(pageIdx)}
                          className="text-xs px-3 py-1 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 rounded transition"
                        >
                          Skip
                        </button>
                      )}
                      {isSkipped && (
                        <span className="text-xs px-3 py-1 bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300 rounded">
                          Skipping
                        </span>
                      )}
                    </div>
                  );
                })}
                {totalPages - perPageResults.length > 5 && (
                  <div className="text-center text-xs text-gray-400 py-1">
                    ...and {totalPages - perPageResults.length - 5} more pages
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {ocrResult && (
          <div className="mt-6">
            <h2 className="text-2xl font-bold mb-4">Combined OCR Result:</h2>
            <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded border border-gray-200 dark:border-gray-700 overflow-auto max-h-96">
              <pre className="whitespace-pre-wrap">{ocrResult}</pre>
            </div>
            <button
              onClick={handleSaveContent}
              className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-2 px-4 rounded transition duration-200 mt-4"
              disabled={saving}
            >
              {saving ? (
                <span className="flex items-center justify-center">
                  <FaSpinner className="animate-spin mr-2" />
                  Saving...
                </span>
              ) : (
                'Save Content'
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ExperimentalOCR;
