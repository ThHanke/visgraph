import { memo, useState, useEffect, useCallback } from 'react';
import { rdfManager } from '../../utils/rdfManager';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Badge } from '../ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { ScrollArea } from '../ui/scroll-area';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Separator } from '../ui/separator';
import { AlertTriangle, CheckCircle, XCircle, Lightbulb, Clock } from 'lucide-react';
import type { ReasoningResult } from '../../utils/rdfManager';

/**
 * Lazy paginated table for inferred triples.
 * Fetches only the current page from the authoritative inferred graph (urn:vg:inferred)
 * when the page or pageSize changes.
 */
const InferredTriplesTable = () => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [pageItems, setPageItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);

  // Fetch the page items lazily from the rdfManager's indexed API
  const fetchPage = useCallback(async (p: number, ps: number) => {
    setLoading(true);
    try {
      const offset = Math.max(0, (p - 1) * ps);
      const res = await rdfManager.fetchQuadsPage({
        graphName: 'urn:vg:inferred',
        offset,
        limit: ps,
        serialize: true
      });
      setTotal(res && typeof res.total === 'number' ? res.total : 0);
      setPageItems(Array.isArray(res.items) ? res.items : []);
    } catch (e) {
      console.error("Failed to fetch inferred triples page", e);
      setPageItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // load initial page
    void fetchPage(page, pageSize);
  }, [page, pageSize, fetchPage]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    setPage((prev) => (prev > totalPages ? totalPages : prev));
  }, [total, pageSize]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const toggleSelect = (idx: number) => {
    setSelected((s) => ({ ...s, [idx]: !s[idx] }));
  };

  const promoteSelected = async () => {
    try {
      const selectedIndices = Object.keys(selected)
        .map((k) => parseInt(k, 10))
        .filter((i) => selected[i]);
      if (selectedIndices.length === 0) {
        window.alert("No triples selected for promotion.");
        return;
      }
      if (!window.confirm(`Promote ${selectedIndices.length} inferred triple(s) into urn:vg:data?`)) return;

      const adds: any[] = [];
      for (const si of selectedIndices) {
        const q = pageItems[si];
        if (!q) continue;
        adds.push({ subject: q.subject, predicate: q.predicate, object: q.object });
      }

      // Persist into data graph and emit subject updates so canvas remaps
      await rdfManager.applyBatch({ removes: [], adds }, "urn:vg:data");
      try { await rdfManager.emitAllSubjects("urn:vg:data"); } catch (_) { /* ignore */ }
      window.alert(`Promoted ${adds.length} triples into urn:vg:data`);
      // clear selection
      setSelected({});
      // refresh current page to reflect potential changes
      void fetchPage(page, pageSize);
    } catch (e) {
      console.error("Promote failed", e);
      window.alert("Promotion failed (see console).");
    }
  };

  const copyTriple = async (q: any) => {
    try {
      const t = `${q.subject} ${q.predicate} ${q.object}`;
      if (navigator && (navigator as any).clipboard && typeof (navigator as any).clipboard.writeText === "function") {
        await (navigator as any).clipboard.writeText(t);
        window.alert("Copied triple to clipboard");
      } else {
        window.prompt("Copy the triple below", t);
      }
    } catch (e) {
      console.error("copy failed", e);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <button className="btn" onClick={() => {
            // select all on current page (local indices)
            const newSel = { ...selected };
            pageItems.forEach((_, i) => { newSel[i] = true; });
            setSelected(newSel);
          }}>Select page</button>
          <button className="btn" onClick={() => setSelected({})}>Clear</button>
          <button className="btn btn-primary" onClick={promoteSelected}>Promote selected</button>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm">Page size</label>
          <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
        </div>
      </div>

      <div className="overflow-x-auto">
        {loading ? (
          <div className="text-center py-8 text-muted-foreground">Loading inferred triples...</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th></th>
                <th>Subject</th>
                <th>Predicate</th>
                <th>Object</th>
                <th>Graph</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((q, i) => {
                const globalIndex = (page - 1) * pageSize + i;
                return (
                  <tr key={globalIndex} className="border-b">
                    <td>
                      <input type="checkbox" checked={!!selected[i]} onChange={() => toggleSelect(i)} />
                    </td>
                    <td className="font-mono break-all">{q.subject}</td>
                    <td className="font-mono break-all">{q.predicate}</td>
                    <td className="font-mono break-all">{q.object}</td>
                    <td className="text-xs text-muted-foreground">{q.graph}</td>
                    <td className="text-right">
                      <button className="btn btn-ghost" onClick={() => copyTriple(q)}>Copy</button>
                    </td>
                  </tr>
                );
              })}
              {pageItems.length === 0 && !loading && (
                <tr>
                  <td colSpan={6} className="text-center text-muted-foreground py-8">No inferred triples on this page.</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex items-center justify-between mt-2">
        <div className="text-sm">Showing page {page} of {totalPages} — {total} triples</div>
        <div className="flex items-center gap-2">
          <button className="btn" onClick={() => { setPage((p) => Math.max(1, p-1)); }} disabled={page <= 1}>Prev</button>
          <button className="btn" onClick={() => { setPage((p) => Math.min(totalPages, p+1)); }} disabled={page >= totalPages}>Next</button>
        </div>
      </div>
    </div>
  );
};

interface ReasoningReportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentReasoning: ReasoningResult | null;
  reasoningHistory: ReasoningResult[];
}

export const ReasoningReportModal = memo(({ open, onOpenChange, currentReasoning, reasoningHistory }: ReasoningReportModalProps) => {
  const [graphCounts, setGraphCounts] = useState<Record<string, number>>({});
  const reasoningId = currentReasoning?.id ?? null;
  const hasReasoning = !!currentReasoning;

  useEffect(() => {
    let cancelled = false;
    const loadGraphCounts = async () => {
      if (!open || !hasReasoning) {
        if (!cancelled) {
          setGraphCounts((prev) => {
            if (!prev || Object.keys(prev).length === 0) {
              return prev;
            }
            return {};
          });
        }
        return;
      }
      try {
        const counts = await rdfManager.getGraphCounts();
        if (!cancelled) {
          setGraphCounts(counts || {});
        }
      } catch (err) {
        if (!cancelled) {
          console.warn("[ReasoningReportModal] Failed to fetch graph counts", err);
          setGraphCounts({});
        }
      }
    };

    void loadGraphCounts();

    return () => {
      cancelled = true;
    };
  }, [open, reasoningId, hasReasoning]);

  if (!currentReasoning) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-4xl max-h-[90vh] max-w-[min(90vw,64rem)] overflow-y-auto text-foreground p-6 bg-white rounded-lg shadow-lg">
          <DialogHeader>
            <DialogTitle>Reasoning Report</DialogTitle>
            <DialogDescription>
              No reasoning results available. Run reasoning on your knowledge graph to see analysis.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  const { errors, warnings, inferences, status, duration, timestamp } = currentReasoning;

  const inferredCount = graphCounts['urn:vg:inferred'] || 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] max-w-[min(90vw,64rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>Reasoning Report</span>
            <Badge variant={status === 'completed' ? 'default' : status === 'error' ? 'destructive' : 'secondary'}>
              {status}
            </Badge>
          </DialogTitle>
          <DialogDescription className="flex items-center gap-4">
            <span>Generated at {new Date(timestamp).toLocaleString()}</span>
            {duration && (
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {duration}ms
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="summary" className="w-full">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="errors" className="flex items-center gap-1">
              Errors
              {errors.length > 0 && (
                <Badge variant="destructive" className="ml-1 h-4 w-4 p-0 text-xs">
                  {errors.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="warnings" className="flex items-center gap-1">
              Warnings
              {warnings.length > 0 && (
                <Badge variant="secondary" className="ml-1 h-4 w-4 p-0 text-xs">
                  {warnings.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="inferences" className="flex items-center gap-1">
              Inferences
              {inferences.length > 0 && (
                <Badge variant="outline" className="ml-1 h-4 w-4 p-0 text-xs">
                  {inferences.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>

          <TabsContent value="summary" className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <XCircle className="w-4 h-4 text-destructive" />
                    Errors
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-destructive">{errors.length}</div>
                </CardContent>
              </Card>
              
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-warning" />
                    Warnings
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-warning">{warnings.length}</div>
                </CardContent>
              </Card>
              
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Lightbulb className="w-4 h-4 text-primary" />
                    Inferences
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold text-primary">{inferences.length}</div>
                </CardContent>
              </Card>
              
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <CheckCircle className="w-4 h-4 text-success" />
                    Status
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-sm font-medium">
                    {errors.length === 0 && warnings.length === 0 ? 'Valid' : 'Issues Found'}
                  </div>
                </CardContent>
              </Card>
            </div>
            
            {status === 'completed' && errors.length === 0 && warnings.length === 0 && (
              <Card className="bg-success/10 border-success/20">
                <CardContent className="pt-4">
                  <div className="flex items-center gap-2 text-success">
                    <CheckCircle className="w-5 h-5" />
                    <span className="font-medium">Knowledge graph is consistent!</span>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Quick preview of top warnings/messages so users see issues immediately in Summary */}
            {(warnings && warnings.length > 0) && (
              <Card className="border-warning/10 bg-warning/5">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-warning" />
                    Inference / Validation Messages (preview)
                    <Badge variant="secondary" className="ml-auto">{warnings.length}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {warnings.slice(0, 5).map((w, i) => (
                      <div key={i} className="text-sm">
                        <div className="font-medium">{w.rule}</div>
                        <div className="text-xs text-muted-foreground break-words">{w.message}</div>
                      </div>
                    ))}
                    {warnings.length > 5 && (
                      <div className="text-xs text-muted-foreground">Showing 5 of {warnings.length} messages. See Warnings tab for full list.</div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="errors">
            <ScrollArea className="h-[400px]">
              <div className="space-y-3">
                {errors.length === 0 ? (
                  <div className="text-center text-muted-foreground py-8">
                    No errors found in the knowledge graph.
                  </div>
                ) : (
                  errors.map((error, index) => (
                    <Card key={index} className="border-destructive/20">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm flex items-center gap-2">
                          <XCircle className="w-4 h-4 text-destructive" />
                          <span>{error.rule}</span>
                          <Badge variant="destructive" className="ml-auto">
                            {error.severity}
                          </Badge>
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="text-sm">{error.message}</p>
                        {(error.nodeId || error.edgeId) && (
                          <p className="text-xs text-muted-foreground mt-2">
                            Affected: {error.nodeId ? `Node ${error.nodeId}` : `Edge ${error.edgeId}`}
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="warnings">
            <ScrollArea className="h-[400px]">
              <div className="space-y-3">
                {warnings.length === 0 ? (
                  <div className="text-center text-muted-foreground py-8">
                    No warnings for the knowledge graph.
                  </div>
                ) : (
                  warnings.map((warning, index) => (
                    <Card key={index} className="border-warning/20">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm flex items-center gap-2">
                          <AlertTriangle className="w-4 h-4 text-warning" />
                          <span>{warning.rule}</span>
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="text-sm">{warning.message}</p>
                        {(warning.nodeId || warning.edgeId) && (
                          <p className="text-xs text-muted-foreground mt-2">
                            Affected: {warning.nodeId ? `Node ${warning.nodeId}` : `Edge ${warning.edgeId}`}
                          </p>
                        )}
                      </CardContent>
                    </Card>
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="inferences">
            <ScrollArea className="h-[400px]">
              <div className="space-y-3">
                {/* Removed the Inferences (summary) preview card per request; keep inferences tab focused on table */}
                {/* Inferred triples table (derived from urn:vg:inferred) */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <span>Inferred Triples</span>
                      <Badge variant="outline" className="ml-auto">
                        {inferredCount}
                      </Badge>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <InferredTriplesTable />
                  </CardContent>
                </Card>
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="history">
            <ScrollArea className="h-[400px]">
              <div className="space-y-3">
                {reasoningHistory.length === 0 ? (
                  <div className="text-center text-muted-foreground py-8">
                    No reasoning history available.
                  </div>
                ) : (
                  reasoningHistory.map((result, index) => (
                    <Card key={result.id}>
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm flex items-center justify-between">
                          <span>{new Date(result.timestamp).toLocaleString()}</span>
                          <div className="flex items-center gap-2">
                            <Badge variant={
                              result.status === 'completed' ? 'default' : 
                              result.status === 'error' ? 'destructive' : 'secondary'
                            }>
                              {result.status}
                            </Badge>
                            {result.duration && (
                              <Badge variant="outline">{result.duration}ms</Badge>
                            )}
                          </div>
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="flex items-center gap-4 text-sm">
                          <span className="flex items-center gap-1">
                            <XCircle className="w-3 h-3 text-destructive" />
                            {result.errors.length} errors
                          </span>
                          <span className="flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3 text-warning" />
                            {result.warnings.length} warnings
                          </span>
                          <span className="flex items-center gap-1">
                            <Lightbulb className="w-3 h-3 text-primary" />
                            {result.inferences.length} inferences
                          </span>
                        </div>
                      </CardContent>
                    </Card>
                  ))
                )}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
});

ReasoningReportModal.displayName = 'ReasoningReportModal';
