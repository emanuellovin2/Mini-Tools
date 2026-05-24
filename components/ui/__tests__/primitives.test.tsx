import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import React from "react";

import { Button } from "../Button";
import { Badge } from "../Badge";
import { Skeleton } from "../Skeleton";
import { EmptyState } from "../EmptyState";
import { Sparkline } from "../Sparkline";
import { KpiCard } from "../KpiCard";
import { DenseTable, DenseRow, DenseCell } from "../DenseTable";
import { Tooltip } from "../Tooltip";
import { Drawer } from "../Drawer";
import { ToastProvider, useToast } from "../Toast";

// ── Button ────────────────────────────────────────────────────────────────────

describe("Button", () => {
  it("renders with default variant and text", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeInTheDocument();
  });

  it("applies size classes", () => {
    const { rerender } = render(<Button size="xs">X</Button>);
    expect(screen.getByRole("button")).toHaveClass("h-6");

    rerender(<Button size="lg">X</Button>);
    expect(screen.getByRole("button")).toHaveClass("h-10");
  });

  it("is disabled when disabled prop passed", () => {
    render(<Button disabled>Nope</Button>);
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("calls onClick handler", () => {
    const handler = vi.fn();
    render(<Button onClick={handler}>Go</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ── Badge ─────────────────────────────────────────────────────────────────────

describe("Badge", () => {
  it("renders children", () => {
    render(<Badge>Active</Badge>);
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("applies ok variant class", () => {
    render(<Badge variant="ok">OK</Badge>);
    const el = screen.getByText("OK");
    expect(el.className).toMatch(/text-ok/);
  });

  it("applies bad variant class", () => {
    render(<Badge variant="bad">Bad</Badge>);
    expect(screen.getByText("Bad").className).toMatch(/text-bad/);
  });

  it("success variant is alias for ok", () => {
    render(<Badge variant="success">S</Badge>);
    expect(screen.getByText("S").className).toMatch(/text-ok/);
  });
});

// ── Skeleton ──────────────────────────────────────────────────────────────────

describe("Skeleton", () => {
  it("renders rect variant by default", () => {
    const { container } = render(<Skeleton />);
    expect(container.firstChild).toHaveClass("animate-pulse");
  });

  it("renders multiple lines when lines > 1", () => {
    const { container } = render(<Skeleton variant="line" lines={3} />);
    const divs = container.querySelectorAll("div");
    expect(divs.length).toBe(4); // wrapper + 3 lines
  });

  it("renders avatar as rounded-full", () => {
    const { container } = render(<Skeleton variant="avatar" />);
    expect(container.firstChild).toHaveClass("rounded-full");
  });
});

// ── EmptyState ────────────────────────────────────────────────────────────────

describe("EmptyState", () => {
  it("renders title, body, and CTA", () => {
    render(
      <EmptyState
        title="No results"
        body="Nothing found here."
        cta={<button>Add one</button>}
      />,
    );
    expect(screen.getByText("No results")).toBeInTheDocument();
    expect(screen.getByText("Nothing found here.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add one" })).toBeInTheDocument();
  });

  it("renders icon when provided", () => {
    render(
      <EmptyState
        icon={<svg data-testid="icon" />}
        title="Empty"
        cta={<button>+</button>}
      />,
    );
    expect(screen.getByTestId("icon")).toBeInTheDocument();
  });
});

// ── Sparkline ─────────────────────────────────────────────────────────────────

describe("Sparkline", () => {
  it("renders an SVG element", () => {
    const { container } = render(<Sparkline points={[1, 2, 3, 4, 5]} />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("renders a path for data points", () => {
    const { container } = render(<Sparkline points={[10, 20, 15, 30]} width={100} height={30} />);
    expect(container.querySelector("path")).not.toBeNull();
  });

  it("renders a fill path when fill=true", () => {
    const { container } = render(<Sparkline points={[10, 20, 15]} fill />);
    const paths = container.querySelectorAll("path");
    expect(paths.length).toBeGreaterThan(0);
  });

  it("does not crash with single data point", () => {
    expect(() => render(<Sparkline points={[42]} />)).not.toThrow();
  });

  it("does not crash with empty data", () => {
    expect(() => render(<Sparkline points={[]} />)).not.toThrow();
  });
});

// ── KpiCard ───────────────────────────────────────────────────────────────────

describe("KpiCard", () => {
  it("renders label and value", () => {
    render(<KpiCard label="MRR" value="$1,200" />);
    expect(screen.getByText("MRR")).toBeInTheDocument();
    expect(screen.getByText("$1,200")).toBeInTheDocument();
  });

  it("shows positive delta with up arrow", () => {
    render(<KpiCard label="MRR" value="$1,200" delta={5.2} />);
    expect(screen.getByText(/5\.2/)).toBeInTheDocument();
    expect(screen.getByText(/↑/)).toBeInTheDocument();
  });

  it("shows negative delta with down arrow", () => {
    render(<KpiCard label="Churn" value="3%" delta={-1.5} />);
    expect(screen.getByText(/↓/)).toBeInTheDocument();
  });

  it("renders sub text when provided", () => {
    render(<KpiCard label="Subs" value="100" sub="vs last month" />);
    expect(screen.getByText("vs last month")).toBeInTheDocument();
  });

  it("renders sparkline when sparkline prop provided", () => {
    const { container } = render(
      <KpiCard label="MRR" value="$500" sparkline={[1, 2, 3, 4, 5]} />,
    );
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});

// ── DenseTable ────────────────────────────────────────────────────────────────

describe("DenseTable", () => {
  it("renders column headings", () => {
    render(
      <DenseTable cols={["Name", "Status", "MRR"]}>
        <DenseRow><DenseCell>Acme</DenseCell><DenseCell>Active</DenseCell><DenseCell>$100</DenseCell></DenseRow>
      </DenseTable>,
    );
    expect(screen.getByText("Name")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("MRR")).toBeInTheDocument();
  });

  it("renders row data", () => {
    render(
      <DenseTable cols={["App"]}>
        <DenseRow><DenseCell>DevTools</DenseCell></DenseRow>
      </DenseTable>,
    );
    expect(screen.getByText("DevTools")).toBeInTheDocument();
  });

  it("calls onRowClick when a row is clicked", () => {
    const handler = vi.fn();
    render(
      <DenseTable cols={["App"]}>
        <DenseRow onClick={handler}><DenseCell>Clickable</DenseCell></DenseRow>
      </DenseTable>,
    );
    fireEvent.click(screen.getByText("Clickable"));
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ── Tooltip ───────────────────────────────────────────────────────────────────

describe("Tooltip", () => {
  it("shows tooltip text after delay on mouseenter", () => {
    vi.useFakeTimers();
    try {
      render(
        <Tooltip content="Hello tooltip">
          <button>Hover me</button>
        </Tooltip>,
      );
      fireEvent.mouseEnter(screen.getByRole("button"));
      expect(screen.queryByText("Hello tooltip")).toBeNull();
      act(() => { vi.advanceTimersByTime(130); });
      expect(screen.getByText("Hello tooltip")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides tooltip on mouseleave", () => {
    vi.useFakeTimers();
    try {
      render(
        <Tooltip content="Bye">
          <button>Hover</button>
        </Tooltip>,
      );
      fireEvent.mouseEnter(screen.getByRole("button"));
      act(() => { vi.advanceTimersByTime(130); });
      expect(screen.getByText("Bye")).toBeInTheDocument();
      fireEvent.mouseLeave(screen.getByRole("button"));
      expect(screen.queryByText("Bye")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── Drawer ────────────────────────────────────────────────────────────────────

describe("Drawer", () => {
  it("does not render content when closed", () => {
    render(
      <Drawer open={false} onClose={() => {}}>
        <div>Drawer content</div>
      </Drawer>,
    );
    expect(screen.queryByText("Drawer content")).toBeNull();
  });

  it("renders content when open", () => {
    render(
      <Drawer open={true} onClose={() => {}}>
        <div>Drawer content</div>
      </Drawer>,
    );
    expect(screen.getByText("Drawer content")).toBeInTheDocument();
  });

  it("calls onClose when backdrop is clicked", () => {
    const onClose = vi.fn();
    render(
      <Drawer open={true} onClose={onClose} title="Test Drawer">
        <div>Content</div>
      </Drawer>,
    );
    const backdrop = document.querySelector('[aria-hidden="true"]');
    if (backdrop) fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it("renders title when provided", () => {
    render(
      <Drawer open={true} onClose={() => {}} title="My Drawer">
        <div>Body</div>
      </Drawer>,
    );
    expect(screen.getByText("My Drawer")).toBeInTheDocument();
  });
});

// ── Toast ─────────────────────────────────────────────────────────────────────

function ToastTestHarness({ message, type }: { message: string; type?: "ok" | "warn" | "bad" }) {
  const addToast = useToast();
  return (
    <button onClick={() => addToast(message, { type })}>Show Toast</button>
  );
}

describe("Toast", () => {
  it("shows toast on trigger", () => {
    render(
      <ToastProvider>
        <ToastTestHarness message="Hello toast" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show Toast" }));
    expect(screen.getByText("Hello toast")).toBeInTheDocument();
  });

  it("renders dismiss button after showing toast", () => {
    render(
      <ToastProvider>
        <ToastTestHarness message="Dismissable" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show Toast" }));
    expect(screen.getByText("Dismissable")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("dismisses immediately on X click", () => {
    render(
      <ToastProvider>
        <ToastTestHarness message="Click to dismiss" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show Toast" }));
    expect(screen.getByText("Click to dismiss")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Click to dismiss")).toBeNull();
  });

  it("auto-dismisses after 5s with fake timers", () => {
    vi.useFakeTimers();
    try {
      render(
        <ToastProvider>
          <ToastTestHarness message="Auto dismiss" />
        </ToastProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Show Toast" }));
      expect(screen.getByText("Auto dismiss")).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(5100); });
      expect(screen.queryByText("Auto dismiss")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
