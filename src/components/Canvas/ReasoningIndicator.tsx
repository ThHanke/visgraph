import { memo } from 'react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Loader2, Brain, AlertTriangle, CheckCircle, XCircle, Play } from 'lucide-react';
import type { ReasoningResult } from '../../utils/rdfManager';

interface ReasoningIndicatorProps {
  onOpenReport: () => void;
  onRunReason?: () => void;
  currentReasoning: ReasoningResult | null;
  isReasoning: boolean;
}

export const ReasoningIndicator = memo(({ onOpenReport, onRunReason, currentReasoning, isReasoning }: ReasoningIndicatorProps) => {
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
    <div className="inline-flex items-center bg-card/80 backdrop-blur-sm border border-border rounded-lg overflow-hidden shadow-sm">
      <Button
        variant="ghost"
        size="sm"
        onClick={onOpenReport}
        className={[
          'rounded-none border-0 h-9 px-3',
          typeof statusInfo.colorKey === 'string' ? STATUS_COLOR_MAP[statusInfo.colorKey] : '',
          statusInfo.pulse ? 'animate-pulse' : '',
          'hover:bg-accent/10 transition-colors',
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
        className="rounded-none border-0 border-l border-border h-9 px-3 hover:bg-accent/10 transition-colors"
        aria-label="Run reasoning"
      >
        <Play className="w-4 h-4" />
      </Button>
    </div>
  );
});

ReasoningIndicator.displayName = 'ReasoningIndicator';
