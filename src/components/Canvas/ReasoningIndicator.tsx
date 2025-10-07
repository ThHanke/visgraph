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

  const STATUS_COLOR_MAP: Record<string, string> = {
    warning: 'bg-warning text-warning-foreground',
    destructive: 'bg-destructive text-destructive-foreground',
    muted: 'bg-muted text-muted-foreground',
    success: 'bg-success text-success-foreground',
  };

  const getStatusInfo = () => {
    if (isReasoning) {
      return {
        icon: <Loader2 className="w-4 h-4 animate-spin" />,
        label: 'Reasoning...',
        colorKey: 'warning',
        pulse: true
      };
    }

    if (!currentReasoning) {
      return {
        icon: <Brain className="w-4 h-4" />,
        label: 'Ready',
        colorKey: 'muted',
        pulse: false
      };
    }

    const { errors, warnings, status } = currentReasoning;

    if (status === 'error') {
      return {
        icon: <XCircle className="w-4 h-4" />,
        label: 'Error',
        colorKey: 'destructive',
        pulse: false
      };
    }

    if (errors.length > 0) {
      return {
        icon: <AlertTriangle className="w-4 h-4" />,
        label: `${errors.length} Error${errors.length !== 1 ? 's' : ''}`,
        colorKey: 'destructive',
        pulse: false
      };
    }

    if (warnings.length > 0) {
      return {
        icon: <AlertTriangle className="w-4 h-4" />,
        label: `${warnings.length} Warning${warnings.length !== 1 ? 's' : ''}`,
        colorKey: 'warning',
        pulse: false
      };
    }

    return {
      icon: <CheckCircle className="w-4 h-4" />,
      label: 'Valid',
      colorKey: 'success',
      pulse: false
    };
  };

  const statusInfo = getStatusInfo();

  return (
    <div className={["flex items-center gap-2", (typeof ({} as any).className === "string" ? "" : "")].filter(Boolean).join(" ")}>
      <Button
        variant="outline"
        size="sm"
        onClick={onOpenReport}
        className={[
          typeof statusInfo.colorKey === 'string' ? STATUS_COLOR_MAP[statusInfo.colorKey] : '',
          'border-2 backdrop-blur-sm shadow-lg',
          statusInfo.pulse ? 'animate-pulse' : '',
          'hover:scale-105 transition-all duration-200',
        ].filter(Boolean).join(' ')}
      >
        {/* ensure classes from STATUS_COLOR_MAP are present in the source for Tailwind scanning */}
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
        className="bg-card/80 hover:bg-accent/5 border border-border px-2 text-foreground"
        aria-label="Run reasoning"
      >
        <Play className="w-4 h-4" />
      </Button>
    </div>
  );
});

ReasoningIndicator.displayName = 'ReasoningIndicator';
