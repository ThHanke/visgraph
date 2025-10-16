import { memo } from 'react';
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
import { useReasoningStore } from '../../stores/reasoningStore';

interface ReasoningReportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const ReasoningReportModal = memo(({ open, onOpenChange }: ReasoningReportModalProps) => {
  const { currentReasoning, reasoningHistory } = useReasoningStore();

  if (!currentReasoning) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-4xl max-h-[90vh] max-w-[min(90vw,64rem)] overflow-y-auto text-foreground">
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
                {inferences.length === 0 ? (
                  <div className="text-center text-muted-foreground py-8">
                    No new inferences derived from the knowledge graph.
                  </div>
                ) : (
                  inferences.map((inference, index) => (
                    <Card key={index} className="border-primary/20">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm flex items-center gap-2">
                          <Lightbulb className="w-4 h-4 text-primary" />
                          <span className="capitalize">{inference.type} Inference</span>
                          <Badge variant="outline" className="ml-auto">
                            {Math.round(inference.confidence * 100)}%
                          </Badge>
                        </CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="font-mono text-sm bg-muted p-2 rounded">
                          {inference.subject} {inference.predicate} {inference.object}
                        </div>
                      </CardContent>
                    </Card>
                  ))
                )}
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