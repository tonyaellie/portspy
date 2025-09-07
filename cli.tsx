#!/usr/bin/env bun
/* eslint-disable no-console */
import React, { useEffect, useMemo, useState } from 'react';
import { render, Box, Text, useApp, useInput, useStdin } from 'ink';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

const execFileAsync = promisify(execFile);

type Proto = 'TCP' | 'UDP';

type PortProc = {
  pid: number;
  process: string;
  user?: string;
  protocol: Proto;
  localAddress: string;
  port: number;
};

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const currentUser = (() => {
  try {
    return os.userInfo().username || process.env.USER || '';
  } catch {
    return process.env.USER || '';
  }
})();

// - - - utils

function parseAddressPort(raw: string): { address: string; port?: string } {
  let s = raw;
  if (s.includes('->')) s = s.split('->')[0];

  const bracketIdx = s.lastIndexOf(']:');
  if (s.startsWith('[') && bracketIdx !== -1) {
    const address = s.slice(1, bracketIdx);
    const port = s.slice(bracketIdx + 2);
    return { address, port };
  }

  const idx = s.lastIndexOf(':');
  if (idx !== -1) {
    const address = s.slice(0, idx);
    const port = s.slice(idx + 1);
    return { address, port };
  }
  return { address: s };
}

function parseLsofFields(stdout: string, forcedProto?: Proto): PortProc[] {
  const lines = stdout.split('\n');
  let curPid: number | null = null;
  let curCmd = '';
  let curUser = '';
  let curProto: Proto | '' = forcedProto || '';

  const out: PortProc[] = [];
  for (const line of lines) {
    if (!line) continue;
    const tag = line[0];
    const val = line.slice(1);
    switch (tag) {
      case 'p':
        curPid = Number.parseInt(val, 10);
        break;
      case 'c':
        curCmd = val;
        break;
      case 'L':
        curUser = val;
        break;
      case 'P':
        curProto = (val as Proto) || curProto;
        break;
      case 'n': {
        if (!curPid || (!curProto && !forcedProto)) break;
        const { address, port } = parseAddressPort(val);
        if (!port) break;
        const portNum = Number.parseInt(port, 10);
        if (Number.isNaN(portNum)) break;

        out.push({
          pid: curPid,
          process: curCmd || '',
          user: curUser || '',
          protocol: (curProto || forcedProto)!,
          localAddress: address || '',
          port: portNum,
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

async function execText(
  file: string,
  args: string[],
  opts?: { timeoutMs?: number }
): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    maxBuffer: 1024 * 1024,
    timeout: opts?.timeoutMs ?? 8000,
  });
  return stdout.toString();
}

function dedupe(entries: PortProc[]): PortProc[] {
  const seen = new Set<string>();
  const out: PortProc[] = [];
  for (const e of entries) {
    const key = `${e.pid}|${e.protocol}|${e.port}|${e.localAddress}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

async function getPortsViaLsof(): Promise<PortProc[]> {
  const tcpOut = await execText('lsof', [
    '-nP',
    '-iTCP',
    '-sTCP:LISTEN',
    '-F',
    'pcPnLn',
  ]);
  const tcp = parseLsofFields(tcpOut, 'TCP');

  const udpOut = await execText('lsof', ['-nP', '-iUDP', '-F', 'pcPnLn']);
  const udp = parseLsofFields(udpOut, 'UDP');

  return dedupe([...tcp, ...udp]);
}

function parseSs(stdout: string): PortProc[] {
  const out: PortProc[] = [];
  for (const line of stdout.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    const parts = s.split(/\s+/);
    if (parts.length < 5) continue;

    const protoStr = parts[0]?.toUpperCase();
    if (protoStr !== 'TCP' && protoStr !== 'UDP') continue;
    const proto = protoStr as Proto;

    const local = parts[4];
    const { address, port } = parseAddressPort(local);
    if (!port) continue;
    const portNum = Number.parseInt(port, 10);
    if (Number.isNaN(portNum)) continue;

    const rest = parts.slice(5).join(' ');
    const pidMatch = rest.match(/pid=(\d+)/);
    const nameMatch = rest.match(/users:\(\("([^"]+)"/);

    const pid = pidMatch ? Number.parseInt(pidMatch[1], 10) : NaN;
    const processName =
      (nameMatch && nameMatch[1]) ||
      (proto === 'TCP' ? 'tcp-listener' : 'udp-socket');

    if (!Number.isNaN(pid)) {
      out.push({
        pid,
        process: processName,
        protocol: proto,
        localAddress: parseAddressPort(local).address || '',
        port: portNum,
      });
    }
  }
  return dedupe(out);
}

async function getPorts(): Promise<PortProc[]> {
  try {
    const entries = await getPortsViaLsof();
    if (entries.length > 0) return entries;
  } catch {
    // Fall through to ss
  }
  const ssOut = await execText('ss', ['-H', '-tunlp']);
  return parseSs(ssOut);
}

function humanAddr(addr: string): string {
  if (addr === '' || addr === '*') return '0.0.0.0';
  if (addr === '::') return '::';
  return addr;
}

function killSignalName(sig: 'TERM' | 'KILL') {
  return sig === 'TERM' ? 'SIGTERM' : 'SIGKILL';
}

function needsSudoHint(e: PortProc): boolean {
  if (isRoot) return false;
  if (!e.user) return false;
  return e.user !== currentUser;
}

function fit(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return text.slice(0, width - 1) + '…';
}

function padRight(s: string, w: number): string {
  if (s.length >= w) return s.slice(0, w);
  return s + ' '.repeat(w - s.length);
}

// - - - banner

const BIG_BANNER = [
  '                                 ',
  ' _____         _   _____         ',
  '|  _  |___ ___| |_|   __|___ _ _ ',
  '|   __| . |  _|  _|__   | . | | |',
  '|__|  |___|_| |_| |_____|  _|_  |',
  '                        |_| |___|',
];

function termSize() {
  return {
    cols: Math.max(40, process.stdout?.columns || 80),
    rows: Math.max(20, process.stdout?.rows || 24),
  };
}

function computeWidths(total: number) {
  // Columns: PORT PROTO PID PROC ADDRESS USER FLAGS
  const min = {
    port: 5,
    proto: 4,
    pid: 6,
    proc: 10,
    addr: 10,
    user: 6,
    flags: 6,
  };
  const sepCount = 7 - 1;
  const sepWidth = sepCount; // 1 space each
  const prefix = 2; // selector + space

  const fixed =
    min.port + min.proto + min.pid + min.user + min.flags + sepWidth + prefix;

  let flex = Math.max(0, total - fixed);
  const baseFlex = min.proc + min.addr;
  if (flex < baseFlex) {
    const ratio = baseFlex ? flex / baseFlex : 0;
    return {
      port: min.port,
      proto: min.proto,
      pid: min.pid,
      proc: Math.max(3, Math.floor(min.proc * ratio)),
      addr: Math.max(3, Math.floor(min.addr * ratio)),
      user: min.user,
      flags: min.flags,
      prefix,
    };
  }
  const extra = flex - baseFlex;
  const wProc = Math.floor(extra / 2);
  const wAddr = extra - wProc;

  return {
    port: min.port,
    proto: min.proto,
    pid: min.pid,
    proc: min.proc + wProc,
    addr: min.addr + wAddr,
    user: min.user,
    flags: min.flags,
    prefix,
  };
}

// - - - app

function App() {
  const { exit } = useApp();
  const { isRawModeSupported, setRawMode } = useStdin();

  const [items, setItems] = useState<PortProc[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchMode, setSearchMode] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const [confirmKill, setConfirmKill] = useState<{
    item: PortProc;
    sig: 'TERM' | 'KILL';
  } | null>(null);

  const [elevatePrompt, setElevatePrompt] = useState<{
    pid: number;
    sig: 'TERM' | 'KILL';
  } | null>(null);

  const [elevating, setElevating] = useState(false);

  const [size, setSize] = useState(() => termSize());
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    const onResize = () => setSize(termSize());
    process.stdout?.on('resize', onResize);
    return () => {
      process.stdout?.off('resize', onResize);
    };
  }, []);

  const filtered = useMemo(() => {
    const arr = items.slice().sort((a, b) => a.port - b.port);
    if (!query) return arr;
    return arr.filter((e) => e.port.toString().includes(query));
  }, [items, query]);

  // Dynamic rows so we occupy the full screen
  const bigBannerOK = size.cols >= 70 && size.rows >= 26;
  const headerLines = bigBannerOK ? BIG_BANNER.length + 1 : 1; // +1 line for tagline
  const fixedTop = headerLines + 1 + 1 + 1; // banner + toolbar + filter + table header
  const fixedBottom =
    (status ? 1 : 0) +
    (confirmKill ? 2 : 0) +
    (elevatePrompt ? 2 : 0) +
    (elevating ? 1 : 0);
  const visibleCount = Math.max(6, size.rows - fixedTop - fixedBottom);

  const start = Math.max(
    0,
    Math.min(
      Math.max(0, selected - Math.floor(visibleCount / 2)),
      Math.max(0, filtered.length - visibleCount)
    )
  );
  const end = Math.min(filtered.length, start + visibleCount);

  async function refresh(silent = false) {
    try {
      if (!silent) {
        setLoading(true);
        setStatus(null);
      }
      setErr(null);
      const data = await getPorts();
      setItems(data);
      if (selected >= data.length) setSelected(0);
    } catch (e: any) {
      const msg =
        e?.stderr?.toString?.() || e?.message || 'failed to fetch ports';
      setErr(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  async function sudoKill(pid: number, sig: 'TERM' | 'KILL') {
    const nodeSig = sig === 'KILL' ? 'SIGKILL' : 'SIGTERM';
    setElevating(true);
    setStatus(
      `Requesting sudo to send ${nodeSig} to pid ${pid}. ` +
        'You may be prompted for your password...'
    );

    try {
      if (isRawModeSupported) setRawMode(false);
    } catch {}
    const child = spawn('sudo', ['kill', '-s', nodeSig, String(pid)], {
      stdio: 'inherit',
    });

    const ok: boolean = await new Promise((resolve) => {
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    });

    try {
      if (isRawModeSupported) setRawMode(true);
    } catch {}

    setElevating(false);
    if (ok) {
      setStatus(`Killed ${pid} with ${nodeSig}. Refreshing...`);
      setTimeout(() => {
        refresh(true).catch(() => {});
      }, 500);
    } else {
      setStatus(
        `Failed to kill ${pid} via sudo. Try running portspy with sudo.`
      );
    }
  }

  async function doKill(pid: number, sig: 'TERM' | 'KILL') {
    const nodeSig = sig === 'KILL' ? 'SIGKILL' : 'SIGTERM';
    try {
      process.kill(pid, nodeSig as NodeJS.Signals);
      setStatus(`Sent ${nodeSig} to pid ${pid}. Refreshing...`);
      setConfirmKill(null);
      setTimeout(() => {
        refresh(true).catch(() => {});
      }, 500);
      return;
    } catch (e: any) {
      const msg = String(e?.message || '');
      const code = e?.code || '';
      const needElevate =
        code === 'EPERM' ||
        /operation not permitted/i.test(msg) ||
        /permission denied/i.test(msg);

      if (needElevate && !isRoot) {
        setConfirmKill(null);
        setElevatePrompt({ pid, sig });
        setStatus(`Insufficient permissions to send ${nodeSig} to ${pid}.`);
        return;
      }
      setStatus(`Failed to kill ${pid}: ${msg || 'unknown error'}`);
      setConfirmKill(null);
    }
  }

  useInput((input, key) => {
    if (showHelp) {
      if (key.escape || input === 'h' || input === '?') {
        setShowHelp(false);
      }
      return;
    }

    // Elevation prompt
    if (elevatePrompt) {
      if (input === 'y' || input === 'Y') {
        void sudoKill(elevatePrompt.pid, elevatePrompt.sig);
        setElevatePrompt(null);
      } else if (input === 'n' || key.escape) {
        setElevatePrompt(null);
        setStatus('Canceled elevation.');
      }
      return;
    }

    // Kill confirmation
    if (confirmKill) {
      if (input === 'y') {
        void doKill(confirmKill.item.pid, confirmKill.sig);
      } else if (input === 'Y') {
        void doKill(confirmKill.item.pid, 'KILL');
      } else if (input === 'n' || key.escape) {
        setConfirmKill(null);
      }
      return;
    }

    // Search mode
    if (searchMode) {
      if (key.return || key.escape) {
        setSearchMode(false);
        return;
      }
      if (input === 'c') {
        setQuery('');
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        return;
      }
      if (/[0-9]/.test(input)) {
        setQuery((q) => (q + input).slice(0, 10));
      }
      return;
    }

    // Normal mode
    if (input === 'q') {
      exit();
      return;
    }
    if (input === '?') {
      setShowHelp(true);
      return;
    }
    if (input === 'h') {
      setShowHelp(true);
      return;
    }
    if (input === 'r') {
      void refresh();
      return;
    }
    if (input === '/') {
      setSearchMode(true);
      return;
    }
    if (input === 'c') {
      setQuery('');
      return;
    }
    if (key.upArrow) {
      setSelected((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelected((i) => Math.min(Math.max(0, filtered.length - 1), i + 1));
      return;
    }
    if (/[0-9]/.test(input)) {
      setSearchMode(true);
      setQuery(input);
      return;
    }
    if (key.return || input === 'k') {
      const item = filtered[selected];
      if (item) setConfirmKill({ item, sig: 'TERM' });
      return;
    }
    if (input === 'K') {
      const item = filtered[selected];
      if (item) setConfirmKill({ item, sig: 'KILL' });
      return;
    }
  });

  const cols = computeWidths(size.cols);

  function rowText(e: PortProc): string {
    const addr = humanAddr(e.localAddress);
    const flags = [
      needsSudoHint(e) ? 'root' : '',
      e.protocol === 'UDP' ? 'udp' : '',
    ]
      .filter(Boolean)
      .join(',');

    const row =
      padRight(fit(e.port.toString(), cols.port), cols.port) +
      ' ' +
      padRight(fit(e.protocol, cols.proto), cols.proto) +
      ' ' +
      padRight(fit(e.pid.toString(), cols.pid), cols.pid) +
      ' ' +
      padRight(fit(e.process || '?', cols.proc), cols.proc) +
      ' ' +
      padRight(fit(addr, cols.addr), cols.addr) +
      ' ' +
      padRight(fit(e.user || '', cols.user), cols.user) +
      ' ' +
      padRight(fit(flags, cols.flags), cols.flags);

    const maxW = size.cols;
    const prefix = '> ';
    return (
      prefix +
      (row.length + prefix.length > maxW
        ? row.slice(0, Math.max(0, maxW - prefix.length))
        : row)
    );
  }

  // Simple filler to occupy the full screen
  function fillerLines(used: number) {
    const remain = Math.max(0, size.rows - used);
    return <Text dimColor>{'\n'.repeat(remain)}</Text>;
  }

  // Render

  // Header
  const header = bigBannerOK ? (
    <Box flexDirection="column">
      {BIG_BANNER.map((ln) => (
        <Text key={ln} color="cyanBright">
          {ln}
        </Text>
      ))}
      <Text dimColor>portspy - see and manage processes bound to ports</Text>
    </Box>
  ) : (
    <Box>
      <Text color="cyanBright">portspy</Text>
      <Text> - see and manage processes bound to ports</Text>
    </Box>
  );

  const toolbar = (
    <Text dimColor>
      up/down select / search digits Enter or k = SIGTERM K = SIGKILL
      {'  '}r refresh c clear ? help q quit
    </Text>
  );

  // Count lines we print to keep screen filled
  const linesBeforeTable = headerLines + 1 + 1; // header + toolbar + filter
  const tableHeaderLines = 1;

  return (
    <Box flexDirection="column">
      {header}
      <Box>{toolbar}</Box>

      <Box>
        {searchMode ? (
          <Text>
            Search (by port): <Text color="yellow">{query || ' '}</Text>{' '}
            <Text dimColor>- press Enter to exit search</Text>
          </Text>
        ) : (
          <Text>
            Filter: <Text color="yellow">{query || ' '}</Text>{' '}
            <Text dimColor>({filtered.length} results)</Text>
          </Text>
        )}
      </Box>

      {showHelp ? (
        <>
          <Box marginTop={1} flexDirection="column" borderStyle="round">
            <Text color="cyan">Help</Text>
            <Text>
              - Navigate: Up/Down. The list height adapts to your terminal.
            </Text>
            <Text>
              - Filter: press '/' or start typing digits. Enter exits search.
            </Text>
            <Text>
              - Kill: Enter or 'k' sends SIGTERM. 'K' sends SIGKILL (-9).
            </Text>
            <Text>
              - Confirm: y yes, Y force SIGKILL, n cancel. If permission is
              denied, you will be offered to retry via sudo.
            </Text>
            <Text>
              - r refresh, c clear filter, q quit, ? or h toggle help.
            </Text>
          </Box>
          {fillerLines(headerLines + 1 + 1 + 8)}
        </>
      ) : loading ? (
        <>
          <Text color="green">Loading...</Text>
          {fillerLines(linesBeforeTable + 1)}
        </>
      ) : err ? (
        <>
          <Box flexDirection="column" marginTop={1}>
            <Text color="red">Error: {err}</Text>
            <Text dimColor>
              Tip: install lsof for best results: sudo apt install lsof
            </Text>
          </Box>
          {fillerLines(linesBeforeTable + 2)}
        </>
      ) : filtered.length === 0 ? (
        <>
          <Text dimColor>No matches.</Text>
          {fillerLines(linesBeforeTable + 1)}
        </>
      ) : (
        <>
          <Text color="gray">
            {padRight('PORT', cols.port)} {padRight('PROTO', cols.proto)}{' '}
            {padRight('PID', cols.pid)} {padRight('PROC', cols.proc)}{' '}
            {padRight('ADDRESS', cols.addr)} {padRight('USER', cols.user)}{' '}
            {padRight('FLAGS', cols.flags)}
          </Text>

          {filtered.slice(start, end).map((e, idx) => {
            const i = start + idx;
            const isSel = i === selected;
            const line = rowText(e);
            return (
              <Text
                key={`${e.pid}-${e.protocol}-${e.port}-${e.localAddress}`}
                color={
                  isSel ? 'black' : e.protocol === 'TCP' ? 'cyan' : 'magenta'
                }
                backgroundColor={isSel ? 'yellow' : undefined}
              >
                {isSel ? line : line.replace(/^> /, '  ')}
              </Text>
            );
          })}

          {fillerLines(linesBeforeTable + tableHeaderLines + (end - start))}
        </>
      )}

      {status ? (
        <Box marginTop={0}>
          <Text dimColor>{status}</Text>
        </Box>
      ) : null}

      {confirmKill ? (
        <Box marginTop={0} flexDirection="column">
          <Text color="red">
            Kill pid {confirmKill.item.pid} ({confirmKill.item.process}) on{' '}
            {confirmKill.item.protocol}:{confirmKill.item.port}? y=
            {killSignalName(confirmKill.sig)} Y=SIGKILL n=cancel
          </Text>
          {needsSudoHint(confirmKill.item) && !isRoot ? (
            <Text dimColor>
              Note: this process is owned by {confirmKill.item.user}. You may be
              prompted for sudo.
            </Text>
          ) : null}
        </Box>
      ) : null}

      {elevatePrompt ? (
        <Box marginTop={0} flexDirection="column">
          <Text color="yellow">
            Insufficient permissions. Retry with sudo to send{' '}
            {killSignalName(elevatePrompt.sig)} to pid {elevatePrompt.pid}?
            y=yes n=cancel
          </Text>
        </Box>
      ) : null}

      {elevating ? (
        <Box marginTop={0} flexDirection="column">
          <Text dimColor>
            Elevating... a sudo prompt may appear in this terminal.
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

render(<App />);
