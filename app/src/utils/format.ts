export function fmtUsd(n: number | null | undefined, opts?: { compact?: boolean; decimals?: number }) {
  if (n == null || isNaN(n)) return '—';
  const { compact = false, decimals } = opts ?? {};
  const abs = Math.abs(n);
  if (compact) {
    if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  }
  if (abs > 0 && abs < 0.01) return `$${n.toExponential(2)}`;
  const dec = decimals ?? (abs >= 100 ? 2 : abs >= 1 ? 3 : 5);
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: dec })}`;
}

export function fmtNum(n: number | null | undefined) {
  if (n == null || isNaN(n)) return '—';
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function fmtPct(n: number | null | undefined, withSign = true) {
  if (n == null || isNaN(n)) return '—';
  const sign = withSign && n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

export function fmtQuantity(n: number | null | undefined) {
  if (n == null || isNaN(n)) return '—';
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  if (Math.abs(n) < 0.0001) return n.toExponential(3);
  return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

export function fmtTime(iso: string | number | Date | undefined) {
  if (!iso) return '—';
  const d = typeof iso === 'number' ? new Date(iso * 1000) : new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

export function timeAgo(unixSeconds: number | undefined) {
  if (!unixSeconds) return '—';
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  return `${Math.floor(diff / 86400)}d`;
}

export function shortAddress(addr: string) {
  if (!addr) return '';
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export function signalFromToken(t: {
  smart_degen_count?: number | null;
  rug_ratio?: number | null;
  is_wash_trading?: boolean | null;
  is_honeypot?: string | number | null;
}): 'pass' | 'watch' | 'skip' {
  if (Number(t.is_honeypot) === 1 || t.is_honeypot === 'yes' || t.is_honeypot === '1') return 'skip';
  if (t.is_wash_trading === true) return 'skip';
  if ((t.rug_ratio ?? 0) > 0.3) return 'skip';
  if ((t.smart_degen_count ?? 0) >= 3 && (t.rug_ratio ?? 1) < 0.2) return 'pass';
  return 'watch';
}