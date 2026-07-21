import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../../../providers/prefixShorten', () => ({
  prefixShorten: (iri: string) => iri,
}));

import { EntailmentExplanation } from '../EntailmentExplanation';

const TRIPLE = {
  subject: 'Alice',
  predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
  object: 'Agent',
};

function getButton() {
  return screen.getByRole('button', { name: /Explain inference/i });
}

function getTooltipText(): string {
  const allDivs = document.querySelectorAll('div[style]');
  for (const el of allDivs) {
    const s = (el as HTMLElement).style;
    if (s.position === 'fixed' && s.zIndex === '99999' && el.textContent) {
      return el.textContent;
    }
  }
  return '';
}

afterEach(() => cleanup());

describe('EntailmentExplanation', () => {
  it('does NOT call explainEntailment on render (lazy)', () => {
    const explain = vi.fn().mockResolvedValue({ isEntailed: true, justifications: [] });
    render(<EntailmentExplanation triple={TRIPLE} explain={explain as any} />);
    expect(explain).not.toHaveBeenCalled();
  });

  it('calls explainEntailment with the exact triple args on click', async () => {
    const explain = vi.fn().mockResolvedValue({ isEntailed: true, justifications: [] });
    render(<EntailmentExplanation triple={TRIPLE} explain={explain as any} />);
    fireEvent.mouseEnter(getButton());
    await waitFor(() => expect(explain).toHaveBeenCalledTimes(1));
    expect(explain).toHaveBeenCalledWith(
      'Alice',
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
      'Agent',
      { objectIsLiteral: undefined },
    );
  });

  it('calls explainEntailment only once (cached after success)', async () => {
    const explain = vi.fn().mockResolvedValue({ isEntailed: true, justifications: [] });
    render(<EntailmentExplanation triple={TRIPLE} explain={explain as any} />);
    fireEvent.mouseEnter(getButton());
    await waitFor(() => expect(explain).toHaveBeenCalledTimes(1));
    fireEvent.mouseEnter(getButton());
    expect(explain).toHaveBeenCalledTimes(1);
  });

  it('shows justification axioms in tooltip', async () => {
    const explain = vi.fn().mockResolvedValue({
      isEntailed: true,
      justifications: [
        [
          { subject: 'Person', predicate: 'http://www.w3.org/2000/01/rdf-schema#subClassOf', object: 'Agent' },
          { subject: 'Alice', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'Person' },
        ],
      ],
    });
    render(<EntailmentExplanation triple={TRIPLE} explain={explain as any} />);
    fireEvent.mouseEnter(getButton());
    await waitFor(() => {
      const tip = getTooltipText();
      expect(tip).toContain('Inferred because:');
      expect(tip).toContain('Person ⊑ Agent');
      expect(tip).toContain('Alice rdf:type Person');
    });
  });

  it('shows vacuous message in tooltip', async () => {
    const explain = vi.fn().mockResolvedValue({ isEntailed: true, vacuous: true, justifications: [] });
    render(<EntailmentExplanation triple={TRIPLE} explain={explain as any} />);
    fireEvent.mouseEnter(getButton());
    await waitFor(() => {
      expect(getTooltipText()).toContain('vacuously');
    });
  });

  it('shows ontology-inconsistent message in tooltip', async () => {
    const explain = vi.fn().mockResolvedValue({ isEntailed: null, ontologyInconsistent: true, justifications: [] });
    render(<EntailmentExplanation triple={TRIPLE} explain={explain as any} />);
    fireEvent.mouseEnter(getButton());
    await waitFor(() => {
      expect(getTooltipText()).toContain('inconsistent');
    });
  });

  it('shows asserted message in tooltip', async () => {
    const explain = vi.fn().mockResolvedValue({ isEntailed: false, justifications: [] });
    render(<EntailmentExplanation triple={TRIPLE} explain={explain as any} />);
    fireEvent.mouseEnter(getButton());
    await waitFor(() => {
      expect(getTooltipText()).toContain('Asserted');
    });
  });

  it('shows no-justification fallback in tooltip', async () => {
    const explain = vi.fn().mockResolvedValue({ isEntailed: true, justifications: [] });
    render(<EntailmentExplanation triple={TRIPLE} explain={explain as any} />);
    fireEvent.mouseEnter(getButton());
    await waitFor(() => {
      expect(getTooltipText()).toContain('no justification');
    });
  });

  it('shows error message in tooltip on rejection', async () => {
    const explain = vi.fn().mockRejectedValue(new Error('reasoner offline'));
    render(<EntailmentExplanation triple={TRIPLE} explain={explain as any} />);
    fireEvent.mouseEnter(getButton());
    await waitFor(() => {
      expect(getTooltipText()).toContain('reasoner offline');
    });
  });

  it('retries after error on next click', async () => {
    const explain = vi.fn()
      .mockRejectedValueOnce(new Error('reasoner offline'))
      .mockResolvedValueOnce({ isEntailed: true, justifications: [] });
    render(<EntailmentExplanation triple={TRIPLE} explain={explain as any} />);
    fireEvent.mouseEnter(getButton());
    await waitFor(() => {
      expect(getTooltipText()).toContain('reasoner offline');
    });
    fireEvent.mouseLeave(getButton());
    fireEvent.mouseEnter(getButton());
    await waitFor(() => expect(explain).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(getTooltipText()).toContain('no justification');
    });
  });

  it('forwards objectIsLiteral', async () => {
    const explain = vi.fn().mockResolvedValue({ isEntailed: true, justifications: [] });
    render(
      <EntailmentExplanation
        triple={{ subject: 'Alice', predicate: 'ex:age', object: '42', objectIsLiteral: true }}
        explain={explain as any}
      />,
    );
    fireEvent.mouseEnter(getButton());
    await waitFor(() => expect(explain).toHaveBeenCalledTimes(1));
    expect(explain).toHaveBeenCalledWith('Alice', 'ex:age', '42', { objectIsLiteral: true });
  });
});
