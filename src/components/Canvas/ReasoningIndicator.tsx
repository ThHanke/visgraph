import { memo } from 'react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Loader2, Brain, AlertTriangle, CheckCircle, XCircle, Play } from 'lucide-react';
import { useReasoningStore } from '../../stores/reasoningStore';

interface ReasoningIndicatorProps {
  onOpenReport: () => void;
  onRunReason?: () => void;
}

export const ReasoningIndicator = memo(({ onOpenReport, onRunReason }: ReasoningIndicatorProps) => {
  const { currentReasoning, isReasoning } = useReasoningStore();

  const getStatusInfo = () => {
    if (isReasoning) {
      return {
        icon: <Loader2 className="w-4 h-4 animate-spin" />,
        label: 'Reasoning...',
        color: 'bg-warning text-warning-foreground',
        pulse: true
      };
    }

    if (!currentReasoning) {
      return {
        icon: <Brain className="w-4 h-4" />,
        label: 'Ready',
        color: 'bg-muted text-muted-foreground',
        pulse: false
      };
    }

    const { errors, warnings, status } = currentReasoning;

    if (status === 'error') {
      return {
        icon: <XCircle className="w-4 h-4" />,
        label: 'Error',
        color: 'bg-destructive text-destructive-foreground',
        pulse: false
      };
    }

    if (errors.length > 0) {
      return {
        icon: <AlertTriangle className="w-4 h-4" />,
        label: `${errors.length} Error${errors.length !== 1 ? 's' : ''}`,
        color: 'bg-destructive text-destructive-foreground',
        pulse: false
      };
    }

    if (warnings.length > 0) {
      return {
        icon: <AlertTriangle className="w-4 h-4" />,
        label: `${warnings.length} Warning${warnings.length !== 1 ? 's' : ''}`,
        color: 'bg-warning text-warning-foreground',
        pulse: false
      };
    }

    return {
      icon: <CheckCircle className="w-4 h-4" />,
      label: 'Valid',
      color: 'bg-success text-success-foreground',
      pulse: false
    };
  };

  const statusInfo = getStatusInfo();

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        onClick={onOpenReport}
        className={`
          ${statusInfo.color} 
          border-2 backdrop-blur-sm shadow-lg
          ${statusInfo.pulse ? 'animate-pulse' : ''}
          hover:scale-105 transition-all duration-200
        `}
      >
        {statusInfo.icon}
        <span className="ml-2 font-medium">{statusInfo.label}</span>
        {currentReasoning?.duration && (
          <Badge variant="secondary" className="ml-2 text-xs">
            {currentReasoning.duration}ms
          </Badge>
        )}
      </Button>

      {/* Run reasoning control (restores previous widget behavior allowing manual runs) */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          try {
            if (typeof onRunReason === 'function') onRunReason();
          } catch (e) {
            // swallow UI-level failures
             
            console.warn('Failed to invoke run reasoning', e);
          }
        }}
        className="bg-card/80 hover:bg-accent/5 border border-border px-2"
        aria-label="Run reasoning"
      >
        <Play className="w-4 h-4" />
      </Button>
    </div>
  );
});

ReasoningIndicator.displayName = 'ReasoningIndicator';
