import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export type Ticket = {
  id: string; title: string; file: string; status: string; progress: string;
  issue: string; blockedBy: string[];
};
const start = '<!-- tracker:start -->';
const end = '<!-- tracker:end -->';
const statuses = ['needs-triage', 'needs-info', 'ready-for-agent', 'ready-for-human', 'wontfix'];

function readyTickets(tickets: Ticket[]): Ticket[] {
  return tickets.filter((ticket) => ticket.status === 'ready-for-agent' && ticket.progress !== '已完成'
    && ticket.blockedBy.every((id) => tickets.some((other) => other.id === id && other.progress === '已完成')));
}

export function renderIndex(tickets: Ticket[]): string {
  const done = tickets.filter((ticket) => ticket.progress === '已完成').map((ticket) => ticket.id);
  return [start, '', `当前已完成：${done.join('、') || '无'}。当前可开始：${readyTickets(tickets).map((ticket) => ticket.id).join('、') || '无'}。`, '',
    '| 本地票 | 标题 | GitHub Issue | 阻塞项 | 实施进度 |',
    '| --- | --- | --- | --- | --- |',
    ...tickets.map((ticket) => `| ${ticket.id} | [${ticket.title}](${ticket.file}) | ${ticket.issue} | ${ticket.blockedBy.join('、') || '无'} | ${ticket.progress} |`),
    '', end].join('\n');
}

export async function inspectTracker(root: string): Promise<{ tickets: Ticket[]; ready: string[]; errors: string[] }> {
  const directory = join(root, 'docs/issues');
  const tickets: Ticket[] = [];
  const errors: string[] = [];
  for (const file of (await readdir(directory)).filter((name) => /^\d+-.*\.md$/.test(name)).sort()) {
    const text = (await readFile(join(directory, file), 'utf8')).replace(/\r\n/g, '\n');
    const field = (name: string) => text.match(new RegExp(`^${name}: (.*)$`, 'm'))?.[1] ?? '';
    for (const name of ['Type', 'Labels', 'Status', 'Assignee', 'Parent', 'Blocked by', 'GitHub Issue']) {
      if (!field(name)) errors.push(`${file}: missing-field ${name}`);
      if ([...text.matchAll(new RegExp(`^${name}:`, 'gm'))].length > 1) errors.push(`${file}: duplicate-field ${name}`);
    }
    if (!statuses.includes(field('Status'))) errors.push(`${file}: invalid-status`);
    if (!/^\[#\d+\]\(https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+\)$/.test(field('GitHub Issue'))) errors.push(`${file}: invalid-mirror`);
    const progress = text.match(/^实施进度：(.*?)。/m)?.[1] ?? '';
    if (!['未开始', '进行中', '已完成'].includes(progress)) errors.push(`${file}: invalid-progress`);
    if (!/^None \(can start immediately\)$|^\[[^\]]+\]\(\d+-[^)]+\.md\)(?:(?:、|, )\[[^\]]+\]\(\d+-[^)]+\.md\))*$/.test(field('Blocked by'))) errors.push(`${file}: invalid-dependency`);
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1]!.split('#')[0]!;
      if (!target || /^https?:\/\//.test(target)) continue;
      const path = resolve(directory, decodeURIComponent(target));
      const inside = relative(root, path);
      try {
        if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('outside');
        await access(path);
      } catch { errors.push(`${file}: broken-link`); }
    }
    tickets.push({
      id: file.split('-')[0]!, file, title: text.match(/^# \d+: (.+)$/m)?.[1] ?? '',
      status: field('Status'), progress,
      issue: field('GitHub Issue'),
      blockedBy: [...field('Blocked by').matchAll(/\]\((\d+)-[^)]+\)/g)].map((match) => match[1]!),
    });
  }
  if (!tickets.length) errors.push('empty-tracker');
  const byId = new Map(tickets.map((ticket) => [ticket.id, ticket]));
  if (byId.size !== tickets.length) errors.push('duplicate-id');
  for (const ticket of tickets) {
    if (!ticket.title) errors.push(`${ticket.file}: missing-title`);
    for (const id of ticket.blockedBy) {
      if (!byId.has(id)) errors.push(`${ticket.file}: missing-dependency ${id}`);
      if (ticket.progress !== '未开始' && byId.get(id)?.progress !== '已完成') errors.push(`${ticket.file}: unfinished-dependency ${id}`);
    }
  }
  const active = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (active.has(id)) { errors.push(`dependency-cycle: ${id}`); return; }
    if (visited.has(id)) return;
    active.add(id);
    for (const next of byId.get(id)?.blockedBy ?? []) visit(next);
    active.delete(id);
    visited.add(id);
  }
  tickets.forEach((ticket) => visit(ticket.id));
  const ready = errors.length ? [] : readyTickets(tickets).map((ticket) => ticket.id);
  const index = (await readFile(join(directory, 'INDEX.md'), 'utf8')).replace(/\r\n/g, '\n');
  const generated = index.match(/<!-- tracker:start -->[\s\S]*?<!-- tracker:end -->/)?.[0];
  if (generated !== renderIndex(tickets)) errors.push('stale-index: run node scripts/tracker.ts --write');
  return { tickets, ready, errors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const root = resolve(args.find((arg) => arg !== '--write') ?? '.');
    let result = await inspectTracker(root);
    if (args.includes('--write')) {
      if (result.errors.some((error) => !error.startsWith('stale-index:'))) throw new Error('invalid-tracker');
      const file = join(root, 'docs/issues/INDEX.md');
      const text = await readFile(file, 'utf8');
      if (!text.includes(start) || !text.includes(end)) throw new Error('missing-index-markers');
      await writeFile(file, text.replace(/<!-- tracker:start -->[\s\S]*?<!-- tracker:end -->/, renderIndex(result.tickets)));
      result = await inspectTracker(root);
    }
    console.log(JSON.stringify({ ready: result.ready, errors: result.errors }));
    process.exitCode = result.errors.length ? 1 : 0;
  } catch {
    console.error('Tracker check could not read the ticket set or index markers.');
    process.exitCode = 1;
  }
}
