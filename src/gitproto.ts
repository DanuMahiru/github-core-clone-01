// The git smart-HTTP surface: info/refs advertisements, upload-pack (protocol v2 and v0)
// and receive-pack (v0). The wire is pkt-lines and sideband frames, as the suite's git
// client speaks them; every object lives in the forge's store.

import {
  ZERO_OID,
  computeFetch,
  decodePktLines,
  encodePktLines,
  isAncestor,
  isObjectId,
  parseTag,
  pktLine,
  pktLineDelim,
  pktLineFlush,
  readPack,
  sidebandPackets,
  writePack,
  type GitObject,
} from './git.ts';
import { type Forge, type Repo } from './store.ts';

const AGENT = 'forge/1.0';

import type { HttpRequest, HttpResponse } from './http.ts';

type GitRequest = HttpRequest;
type GitResponse = HttpResponse;

const json = (status: number, body: unknown): GitResponse => ({
  status,
  contentType: 'application/json; charset=utf-8',
  body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'),
});

const notFound = (message: string): GitResponse => json(404, { message });
const badRequest = (message: string): GitResponse => json(400, { message });

function header(req: GitRequest, name: string): string | undefined {
  return req.headers.get(name.toLowerCase());
}

/** All refs of a repo, in advertisement order: HEAD, then branches, then tags. */
function listRefs(repo: Repo): Array<{ name: string; oid: string; peeled?: string }> {
  const refs: Array<{ name: string; oid: string; peeled?: string }> = [];
  const headTip = repo.refs.get('refs/heads/main');
  if (headTip !== undefined) refs.push({ name: 'HEAD', oid: headTip });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const object = repo.objects.get(oid);
    let peeled: string | undefined;
    if (object !== undefined && object.type === 'tag') {
      const tag = parseTag(object.data);
      const target = repo.objects.get(tag.object);
      if (target !== undefined && target.type === 'commit') peeled = tag.object;
    }
    refs.push({ name, oid, peeled });
  }
  return refs;
}

/** A v0 advertisement: service preamble, then ref lines, caps on the first line. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? 'symref=HEAD:refs/heads/main agent=forge/1.0 side-band-64k thin-pack ofs-delta multi_ack_detailed shallow object-format=sha1'
      : 'symref=HEAD:refs/heads/main agent=forge/1.0 report-status report-status-v2 side-band-64k delete-refs ofs-delta object-format=sha1';
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktLineFlush()];
  const refs = listRefs(repo);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      lines.push(index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`);
      if (ref.peeled !== undefined) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    });
  }
  for (const line of lines) parts.push(pktLine(line));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/** A v2 advertisement: service preamble, then "version 2" and its capabilities. */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktLineFlush(),
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktLineFlush(),
  ]);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(forge: Forge, owner: string, repoName: string, req: GitRequest): GitResponse {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return notFound(`repository ${owner}/${repoName} does not exist`);
  const service = req.url.searchParams.get('service');
  if (service === 'git-upload-pack') {
    if (header(req, 'git-protocol') === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(repo, service) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(repo, service) };
  }
  return notFound(`unknown service ${service ?? ''}`);
}

/** Parse a request body into pkt-line packets (throws on malformed input). */
function parsePackets(body: Buffer): Array<{ kind: string; payload?: Buffer }> {
  return decodePktLines(body);
}

// -------------------------------------------------------------------------------------------------
// upload-pack
// -------------------------------------------------------------------------------------------------

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(forge: Forge, owner: string, repoName: string, req: GitRequest): GitResponse {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return notFound(`repository ${owner}/${repoName} does not exist`);
  let packets;
  try {
    packets = parsePackets(req.body);
  } catch (err) {
    return badRequest(`malformed pkt-line request: ${(err as Error).message}`);
  }
  if (header(req, 'git-protocol') === 'version=2') {
    return uploadPackV2(repo, packets);
  }
  return uploadPackV0(repo, packets);
}

/** The v2 ls-refs answer: refs, filtered server-side by the requested prefixes. */
function lsRefsV2(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const refs = listRefs(repo);
  const lines: string[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (refs.length === 0) {
    if (unborn) lines.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
  } else {
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (ref.name === 'HEAD' && symrefs) line += ' symref-target:refs/heads/main';
      if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
      lines.push(`${line}\n`);
    }
  }
  const parts: Buffer[] = lines.map((line) => pktLine(line));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/** The v2 fetch answer: acknowledgments, shallow-info, then the packfile section. */
function fetchV2(repo: Repo, args: string[]): GitResponse {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isSafeInteger(n) && n > 0) depth = n;
    }
  }
  for (const want of wants) {
    if (!isObjectId(want)) return badRequest(`fetch wants a bad object id ${JSON.stringify(want)}`);
    if (!repo.objects.has(want)) return badRequest(`fetch wants an object this forge does not hold: ${want}`);
  }
  const plan = computeFetch(repo.objects, wants, haves, depth, shallow);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.nak) parts.push(pktLine('NAK\n'));
  else {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    if (haves.length > 0 && plan.acks.length === haves.length) parts.push(pktLine('ready\n'));
  }
  parts.push(pktLineDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktLineDelim());
  }
  parts.push(pktLine('packfile\n'));
  // Order the pack's objects deterministically by id (the bytes, not the size).
  const ordered = [...plan.objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const orderedPack = writePack(ordered.map(([, object]) => object));
  for (const packet of sidebandPackets(1, orderedPack)) parts.push(packet);
  parts.push(pktLineFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function uploadPackV2(repo: Repo, packets: Array<{ kind: string; payload?: Buffer }>): GitResponse {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data' && packet.payload !== undefined) {
      lines.push(packet.payload.toString('utf8'));
    }
  }
  if (lines.length === 0) return badRequest('empty upload-pack request');
  const command = (lines[0] ?? '').replace(/\n$/, '');
  // The arguments follow the first delim; agent/object-format lines precede it.
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind === 'data' && packet.payload !== undefined && afterDelim) {
      args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
  }
  if (command === 'command=ls-refs') {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsV2(repo, args) };
  }
  if (command === 'command=fetch') {
    return fetchV2(repo, args);
  }
  return badRequest(`unknown upload-pack command ${JSON.stringify(command)}`);
}

/** The v0 fetch answer: NAK/ACK and shallow lines, then the sideband pack, then a flush. */
function uploadPackV0(repo: Repo, packets: Array<{ kind: string; payload?: Buffer }>): GitResponse {
  // Two sections, split on the first flush: wants (+shallow/deepen), then haves + done.
  const sections: string[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sections.push([]);
      continue;
    }
    if (packet.kind === 'data' && packet.payload !== undefined) {
      (sections[sections.length - 1] as string[]).push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of sections[0] ?? []) {
    if (line.startsWith('want ')) {
      // The first want line carries capabilities after the oid; take the oid only.
      const oid = line.slice(5).split(' ')[0] as string;
      wants.push(oid);
    } else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isSafeInteger(n) && n > 0) depth = n;
    }
  }
  for (const line of sections[1] ?? []) {
    if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  for (const want of wants) {
    if (!isObjectId(want)) return badRequest(`fetch wants a bad object id ${JSON.stringify(want)}`);
    if (!repo.objects.has(want)) return badRequest(`fetch wants an object this forge does not hold: ${want}`);
  }
  const plan = computeFetch(repo.objects, wants, haves, depth, shallow);
  const parts: Buffer[] = [];
  if (plan.nak) parts.push(pktLine('NAK\n'));
  else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const ordered = [...plan.objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const pack = writePack(ordered.map(([, object]) => object));
  for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  parts.push(pktLineFlush());
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// -------------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------------

/** Split a receive-pack body into command pkt-lines and the pack that follows the flush. */
function splitReceivePack(body: Buffer): { commands: string[]; pack: Buffer } {
  const commands: string[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('pkt-line header is truncated');
    const length = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) throw new Error('pkt-line header is not hex');
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length === 1) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) throw new Error('pkt-line is truncated');
    commands.push(body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, ''));
    offset += length;
  }
  return { commands, pack: body.subarray(offset) };
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(forge: Forge, owner: string, repoName: string, req: GitRequest): GitResponse {
  const repo = forge.getRepo(owner, repoName);
  if (repo === undefined) return notFound(`repository ${owner}/${repoName} does not exist`);
  let split;
  try {
    split = splitReceivePack(req.body);
  } catch (err) {
    return badRequest(`malformed pkt-line request: ${(err as Error).message}`);
  }
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  for (const [index, raw] of split.commands.entries()) {
    // The first line may carry capabilities after a NUL.
    const line = index === 0 ? raw.split('\0')[0] as string : raw;
    const parts = line.split(' ');
    if (parts.length < 3) return badRequest(`bad receive-pack command ${JSON.stringify(line)}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isObjectId(oldOid) || !isObjectId(newOid)) return badRequest('receive-pack command has a bad object id');
    if (!ref.startsWith('refs/')) return badRequest(`receive-pack command has a bad ref ${JSON.stringify(ref)}`);
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) return badRequest('receive-pack needs at least one command');

  // Unpack first: the objects land even when a ref update is refused.
  let unpackError: string | null = null;
  let unpacked: Map<string, GitObject> | null = null;
  if (split.pack.length > 0) {
    try {
      const read = readPack(split.pack, { resolveBase: (oid) => repo.objects.get(oid) });
      unpacked = read.objects;
    } catch (err) {
      unpackError = (err as Error).message;
    }
  } else if (commands.some((command) => command.newOid !== ZERO_OID)) {
    unpackError = 'a command list that creates or updates a ref must carry a pack';
  }
  if (unpacked !== null) {
    for (const [oid, object] of unpacked) repo.objects.putExisting(oid, object.type, object.data);
  }

  interface ReportLine {
    ref: string;
    ok: boolean;
    reason: string;
  }
  const report: ReportLine[] = [];
  if (unpackError !== null) {
    for (const command of commands) {
      report.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
    }
    const inner = encodePktLines([
      `unpack ${unpackError}\n`,
      ...report.map((line) => `ng ${line.ref} ${line.reason}\n`),
    ]);
    const body = Buffer.concat([...sidebandPackets(1, inner), pktLineFlush()]);
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body };
  }

  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? null;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === null) report.push({ ref: command.ref, ok: false, reason: 'no such ref' });
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        report.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Create or update.
    if (!repo.objects.has(command.newOid)) {
      report.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== null) {
        report.push({ ref: command.ref, ok: false, reason: 'already exists' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (current === null || command.oldOid !== current) {
      report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!isAncestor(repo.objects, command.oldOid, command.newOid)) {
      report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    report.push({ ref: command.ref, ok: true, reason: '' });
  }

  const inner = encodePktLines([
    'unpack ok\n',
    ...report.map((line) => (line.ok ? `ok ${line.ref}\n` : `ng ${line.ref} ${line.reason}\n`)),
  ]);
  const body = Buffer.concat([...sidebandPackets(1, inner), pktLineFlush()]);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body };
}
