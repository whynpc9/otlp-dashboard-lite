import { useEffect, useRef, type ReactNode, type RefObject } from "react";

export type SortDirection = "asc" | "desc";

const LIVE_SCROLL_THRESHOLD_PX = 48;
export const MAX_LIVE_TABLE_ROWS = 2000;

export function limitRowsForLiveView<T>(rows: T[], direction: SortDirection): T[] {
  if (rows.length <= MAX_LIVE_TABLE_ROWS) return rows;
  return direction === "desc" ? rows.slice(0, MAX_LIVE_TABLE_ROWS) : rows.slice(-MAX_LIVE_TABLE_ROWS);
}

function useLiveScrollAnchor(
  scrollRef: RefObject<HTMLDivElement | null>,
  itemCount: number,
  sortDirection: SortDirection,
  live: boolean
) {
  const anchorRef = useRef<"start" | "end" | null>(sortDirection === "desc" ? "start" : "end");

  useEffect(() => {
    anchorRef.current = sortDirection === "desc" ? "start" : "end";
    const el = scrollRef.current;
    if (!el || !live) return;
    el.scrollTop = sortDirection === "desc" ? 0 : el.scrollHeight;
  }, [sortDirection, live, scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const updateAnchor = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const distanceFromTop = el.scrollTop;
      if (sortDirection === "desc") {
        anchorRef.current = distanceFromTop <= LIVE_SCROLL_THRESHOLD_PX ? "start" : null;
      } else {
        anchorRef.current = distanceFromBottom <= LIVE_SCROLL_THRESHOLD_PX ? "end" : null;
      }
    };

    updateAnchor();
    el.addEventListener("scroll", updateAnchor, { passive: true });
    return () => el.removeEventListener("scroll", updateAnchor);
  }, [scrollRef, sortDirection]);

  useEffect(() => {
    if (!live) return;
    const el = scrollRef.current;
    if (!el) return;
    if (sortDirection === "desc" && anchorRef.current === "start") {
      el.scrollTop = 0;
    } else if (sortDirection === "asc" && anchorRef.current === "end") {
      el.scrollTop = el.scrollHeight;
    }
  }, [itemCount, sortDirection, live, scrollRef]);
}

export function DataGrid({
  className,
  header,
  children,
  itemCount,
  timestampSort,
  live,
  truncatedTotal
}: {
  className: string;
  header: ReactNode;
  children: ReactNode;
  itemCount: number;
  timestampSort: SortDirection;
  live: boolean;
  truncatedTotal?: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useLiveScrollAnchor(scrollRef, itemCount, timestampSort, live);
  const truncated = truncatedTotal !== undefined && truncatedTotal > itemCount;

  return (
    <div className={`panel data-grid ${className}`}>
      {header}
      {truncated ? (
        <div className="data-grid-notice" role="status">
          Showing {itemCount.toLocaleString()} of {truncatedTotal!.toLocaleString()} rows (newest retained for live view)
        </div>
      ) : null}
      <div className="data-grid-scroll" ref={scrollRef}>
        {children}
      </div>
    </div>
  );
}
