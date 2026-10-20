import { useEffect, useState } from "preact/hooks";
import type { DiagnosticTraceRecord } from "../../../bridge/contracts.js";
import { errorMessage } from "../shared.js";

export function useDiagnosticTimeline(
  traceId: string | null | undefined,
  expanded: boolean,
) {
  const [records, setRecords] = useState<
    readonly DiagnosticTraceRecord[] | null
  >(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!expanded || !traceId) return;
    let active = true;
    setRecords(null);
    setMore(false);
    setError(null);
    void window.matrix.readDiagnosticTrace({ traceId, limit: 500 }).then(
      (next) => {
        if (!active) return;
        setRecords(next);
        setMore(next.length === 500);
      },
      (reason) => {
        if (active) setError(errorMessage(reason, "读取诊断时间线失败"));
      },
    );
    return () => {
      active = false;
    };
  }, [expanded, traceId]);

  return { records, setRecords, more, setMore, error };
}
