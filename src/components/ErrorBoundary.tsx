import React, { Component, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * ErrorBoundary component to catch React errors and provide graceful recovery
 * Specifically handles localStorage-related errors by clearing and reloading
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
  }

  handleReset = () => {
    // Clear localStorage and reload
    try {
      localStorage.clear();
      window.location.reload();
    } catch (e) {
      console.error('[ErrorBoundary] Failed to reset:', e);
      window.location.reload();
    }
  };

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          padding: '2rem',
          fontFamily: 'system-ui, sans-serif',
        }}>
          <h1 style={{ fontSize: '2rem', marginBottom: '1rem' }}>
            Something went wrong
          </h1>
          <p style={{ marginBottom: '2rem', textAlign: 'center', maxWidth: '500px' }}>
            The application encountered an error. We're automatically recovering by clearing corrupted settings...
          </p>
          <div style={{ marginBottom: '2rem', padding: '1rem', background: '#f5f5f5', borderRadius: '4px', maxWidth: '600px' }}>
            <pre style={{ margin: 0, fontSize: '0.875rem', overflow: 'auto' }}>
              {this.state.error?.message || 'Unknown error'}
            </pre>
          </div>
          <button
            onClick={this.handleReset}
            style={{
              padding: '0.75rem 1.5rem',
              fontSize: '1rem',
              background: '#2563eb',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
            }}
          >
            Reset and Reload
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
