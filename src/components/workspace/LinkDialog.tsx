import { AlertTriangle, ArrowRight, Check, Link2, Trash2, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { WorkspaceApi } from '../../app/api';
import type { AliasIssue, LinkReport, NetLinkRow, PinLinkRow, RefLinkRow } from '../../lib/crossprobe';
import type { AliasRejection, WorkspaceAliases } from '../../lib/documents';
import { aliasCreationText, aliasRemovalKey } from './alias-outcome';
import { Modal, naturalOrder } from './ui';
import { useUi } from './ui-context';

const LIST_LIMIT = 100;
const fold = (text: string) => text.normalize('NFKC').toLowerCase();

interface Props { api: WorkspaceApi; aliases: WorkspaceAliases; onCreate(kind: 'refs' | 'nets', from: string, to: string): AliasRejection | null; onRemove(kind: 'refs' | 'nets', from: string): boolean; onClose(): void }

/** Link and alias panel: lists what differs, lets the technician confirm an alias explicitly (never auto-applied) and remove existing ones. */
export function LinkDialog({ api, aliases, onCreate, onRemove, onClose }: Props) {
  const { t } = useUi();
  const { state } = api;
  const link: LinkReport | null = state.link;
  const [refFrom, setRefFrom] = useState('');
  const [refTo, setRefTo] = useState('');
  const [netFrom, setNetFrom] = useState('');
  const [netTo, setNetTo] = useState('');
  const [netFilter, setNetFilter] = useState('');
  const [message, setMessage] = useState('');

  const model = useMemo(() => {
    if (!link) return null;
    const schOnly = link.refs.rows.filter((row: RefLinkRow) => row.status === 'schematic-only');
    const boardOnly = link.refs.rows.filter((row: RefLinkRow) => row.status === 'board-only');
    const schRefs = schOnly.map(row => ({ ref: row.schematicRefs[0] ?? row.ref, flagged: row.caseInsensitive.boardRefs })).sort((a, b) => naturalOrder(a.ref, b.ref));
    const boardRefs = boardOnly.map(row => ({ ref: row.ref, count: row.boardComponentsTotal, flagged: row.caseInsensitive.schematicRefs })).sort((a, b) => naturalOrder(a.ref, b.ref));
    const boardNets = (state.board?.nets ?? []).map(net => net.name).filter(Boolean).sort(naturalOrder);
    const netsByFold = new Map<string, string[]>();
    for (const name of boardNets) { const key = fold(name); netsByFold.set(key, [...(netsByFold.get(key) ?? []), name]); }
    const schNets = new Set<string>();
    for (const row of link.schematicOnlyNets.rows) schNets.add(row.name);
    const pairs: Array<{ sch: string; board: string; pins: number }> = [];
    for (const row of link.nets.rows as NetLinkRow[]) if (row.relation === 'differs') for (const net of row.schematicNets) if (net.name !== row.boardNet) { schNets.add(net.name); pairs.push({ sch: net.name, board: row.boardNet, pins: net.pins }); }
    const diffPins = link.pins.rows.filter((row: PinLinkRow) => row.status !== 'match' && row.status !== 'net-unknown');
    return { schRefs, boardRefs, boardNets, netsByFold, schNets: [...schNets].sort(naturalOrder), pairs, diffPins };
  }, [link, state.board]);

  const refEntries = Object.entries(aliases.refs).sort((a, b) => naturalOrder(a[0], b[0]));
  const netEntries = Object.entries(aliases.nets).sort((a, b) => naturalOrder(a[0], b[0]));
  const issues = (kind: 'ref' | 'net', from: string, to: string) => (link?.aliasIssues.rows ?? []).filter(issue => issue.kind === kind && issue.from === from && issue.to === to);
  const persisted = state.persistence === 'native';
  const orNone = (value: string): string => value || t('linkDialog.none');
  const issueText = (issue: AliasIssue): string => {
    const source = issue.problem === 'source-missing';
    const name = source ? issue.from : issue.to;
    if (issue.kind === 'ref') return t(source ? 'linkDialog.issueSourceRef' : 'linkDialog.issueTargetRef', { name });
    return t(source ? 'linkDialog.issueSourceNet' : 'linkDialog.issueTargetNet', { name });
  };

  const refChoice = model?.schRefs.find(item => item.ref === refFrom);
  const boardRefOptions = useMemo(() => {
    if (!model) return [];
    const flagged = new Set(refChoice?.flagged ?? []);
    return [...model.boardRefs].sort((a, b) => Number(flagged.has(b.ref)) - Number(flagged.has(a.ref)) || naturalOrder(a.ref, b.ref)).slice(0, 400);
  }, [model, refChoice]);
  const netFlagged = useMemo(() => new Set(model && netFrom ? model.netsByFold.get(fold(netFrom))?.filter(name => name !== netFrom) ?? [] : []), [model, netFrom]);
  const netOptions = useMemo(() => {
    if (!model) return [];
    const needle = fold(netFilter.trim());
    const base = needle ? model.boardNets.filter(name => fold(name).includes(needle)) : model.boardNets;
    return [...base].sort((a, b) => Number(netFlagged.has(b)) - Number(netFlagged.has(a))).slice(0, LIST_LIMIT);
  }, [model, netFilter, netFlagged]);
  const netHints = useMemo(() => (model && netFrom ? model.pairs.filter(pair => pair.sch === netFrom) : []), [model, netFrom]);

  // Each action reports inside the dialog: the success sentence only after a real change, otherwise the catalog failure followed by
  // its reason. A rejected create keeps the form so the technician can correct it; the controller's toast repeats the reason in English.
  const createRef = () => { if (!refFrom || !refTo) return; const rejection = onCreate('refs', refFrom, refTo); setMessage(aliasCreationText('refs', rejection, refFrom, refTo, t)); if (!rejection) { setRefFrom(''); setRefTo(''); } };
  const createNet = () => { if (!netFrom || !netTo) return; const rejection = onCreate('nets', netFrom, netTo); setMessage(aliasCreationText('nets', rejection, netFrom, netTo, t)); if (!rejection) { setNetFrom(''); setNetTo(''); setNetFilter(''); } };
  const remove = (kind: 'refs' | 'nets', from: string) => { const removed = onRemove(kind, from); setMessage(t(aliasRemovalKey(removed), { name: from })); };
  const list = <Row,>(rows: readonly Row[], render: (row: Row, index: number) => React.ReactNode, total = rows.length) => <>{rows.slice(0, LIST_LIMIT).map(render)}{total > LIST_LIMIT && <li className="muted">{t('linkDialog.more', { count: String(total - LIST_LIMIT) })}</li>}</>;

  return <Modal title={t('linkDialog.title')} closeLabel={t('common.close')} wide testId="link-dialog" close={onClose} initialFocus="[data-testid=alias-ref-from]">
    <div className="wsp-link">
      <p className="settings-hint">{t('linkDialog.intro')}</p>
      <p className={'wsp-persist wsp-link-persist' + (persisted ? ' ok' : '')} role="note" data-testid="alias-persistence">{persisted ? <Check size={13} /> : <TriangleAlert size={13} />}{persisted ? t('linkDialog.persisted') : t('linkDialog.sessionOnly')}</p>
      {message && <p className="wsp-export-result" role="status" data-testid="alias-message">{message}</p>}
      {!link || !model ? <p className="empty-caption" data-testid="link-empty">{t('linkDialog.noLink')}</p> : <>
        <section className="wsp-link-summary" aria-label={t('linkDialog.summary')} data-testid="link-summary">
          <span>{t('linkDialog.refsLinked', { count: String(link.summary.refs.unique) })}</span><span>{t('linkDialog.refsAlias', { count: String(link.summary.refs.alias) })}</span><span className={link.summary.refs.ambiguous ? 'warn' : ''}>{t('linkDialog.refsAmbiguous', { count: String(link.summary.refs.ambiguous) })}</span>
          <span className={link.summary.refs.schematicOnly ? 'warn' : ''}>{t('linkDialog.schOnly', { count: String(link.summary.refs.schematicOnly) })}</span><span>{t('linkDialog.boardOnly', { count: String(link.summary.refs.boardOnly) })}</span>
          <span className={link.summary.nets.differs ? 'warn' : ''}>{t('linkDialog.netsDiffer', { count: String(link.summary.nets.differs) })}</span><span className={link.summary.pins.netDiffers ? 'warn' : ''}>{t('linkDialog.pinsDiffer', { count: String(link.summary.pins.netDiffers + link.summary.pins.pinMissingOnBoard + link.summary.pins.pinMissingOnSchematic) })}</span>
        </section>

        <section className="wsp-link-block" aria-labelledby="wsp-link-refs"><h3 id="wsp-link-refs">{t('linkDialog.refs')}</h3><p className="settings-hint">{t('linkDialog.refsHint')}</p>
          {model.schRefs.length === 0 ? <p className="empty-caption">{t('linkDialog.noSchOnlyRefs')}</p> : <div className="wsp-link-form" role="group" aria-label={t('linkDialog.createRef')}>
            <label><span>{t('linkDialog.schRef')}</span><select value={refFrom} data-testid="alias-ref-from" onChange={e => { setRefFrom(e.target.value); setRefTo(''); setMessage(''); }}>
              <option value="">{t('linkDialog.chooseSchRef')}</option>
              {model.schRefs.slice(0, 400).map(item => <option key={item.ref} value={item.ref}>{item.ref}{aliases.refs[item.ref] !== undefined ? ` — ${t('linkDialog.alreadyAliased')}` : ''}{item.flagged.length ? ` — ${t('linkDialog.flagged')}: ${item.flagged.join(', ')}` : ''}</option>)}</select></label>
            <ArrowRight size={15} className="wsp-link-arrow" aria-hidden="true" />
            <label><span>{t('linkDialog.boardRef')}</span><select value={refTo} data-testid="alias-ref-to" disabled={!refFrom} onChange={e => { setRefTo(e.target.value); setMessage(''); }}>
              <option value="">{t('linkDialog.chooseBoardRef')}</option>
              {boardRefOptions.map(item => <option key={item.ref} value={item.ref}>{item.ref}{item.count > 1 ? ` (${t('linkDialog.components', { count: String(item.count) })})` : ''}{refChoice?.flagged.includes(item.ref) ? ` — ${t('linkDialog.caseFlag')}` : ''}</option>)}</select></label>
            <button type="button" className="primary-button" data-testid="alias-ref-create" disabled={!refFrom || !refTo} onClick={createRef}><Link2 size={14} />{t('linkDialog.createRef')}</button>
            {refFrom && refTo && <p className="wsp-link-consequence" data-testid="alias-ref-consequence">{t('linkDialog.refConsequence', { source: refFrom, target: refTo })}{refChoice?.flagged.includes(refTo) ? ` ${t('linkDialog.caseFlag')}.` : ''}</p>}
          </div>}
          <details className="wsp-link-lists"><summary>{t('linkDialog.schOnly', { count: String(model.schRefs.length) })} · {t('linkDialog.boardOnly', { count: String(model.boardRefs.length) })}</summary>
            <div className="wsp-link-columns"><ul aria-label={t('linkDialog.schOnly', { count: String(model.schRefs.length) })}>{list(model.schRefs, item => <li key={item.ref}><button type="button" className="wsp-link-pick mono" onClick={() => { setRefFrom(item.ref); setRefTo(''); }}>{item.ref}</button>{item.flagged.length > 0 && <em className="wsp-chip warn">{t('linkDialog.flagged')}: {item.flagged.join(', ')}</em>}</li>)}</ul>
              <ul aria-label={t('linkDialog.boardOnly', { count: String(model.boardRefs.length) })}>{model.boardRefs.length === 0 ? <li className="muted">{t('linkDialog.noBoardOnlyRefs')}</li> : list(model.boardRefs, item => <li key={item.ref}><span className="mono">{item.ref}</span>{item.flagged.length > 0 && <em className="wsp-chip warn">{t('linkDialog.flagged')}: {item.flagged.join(', ')}</em>}</li>)}</ul></div>
            {link.refs.truncated && <p className="wsp-reason">{t('linkDialog.truncated')}</p>}
          </details>
        </section>

        <section className="wsp-link-block" aria-labelledby="wsp-link-nets"><h3 id="wsp-link-nets">{t('linkDialog.nets')}</h3><p className="settings-hint">{t('linkDialog.netsHint')}</p>
          {model.schNets.length === 0 && !netFrom ? <p className="empty-caption">{t('linkDialog.noNetCandidates')}</p> : <div className="wsp-link-form" role="group" aria-label={t('linkDialog.createNet')}>
            <label><span>{t('linkDialog.schNet')}</span><select value={netFrom} data-testid="alias-net-from" onChange={e => { setNetFrom(e.target.value); setNetTo(''); setMessage(''); }}>
              <option value="">{t('linkDialog.chooseSchNet')}</option>{[...new Set([...(netFrom ? [netFrom] : []), ...model.schNets])].slice(0, 400).map(name => <option key={name} value={name}>{name}{aliases.nets[name] !== undefined ? ` — ${t('linkDialog.alreadyAliased')}` : ''}</option>)}</select></label>
            <ArrowRight size={15} className="wsp-link-arrow" aria-hidden="true" />
            <div className="wsp-link-netpick"><label><span>{t('linkDialog.boardNet')}</span><input type="search" value={netFilter} placeholder={t('linkDialog.filterNets')} aria-label={t('linkDialog.filterNets')} data-testid="alias-net-filter" disabled={!netFrom} onChange={e => setNetFilter(e.target.value)} /></label>
              <select value={netTo} size={5} aria-label={t('linkDialog.boardNet')} data-testid="alias-net-to" disabled={!netFrom} onChange={e => { setNetTo(e.target.value); setMessage(''); }}>
                {netOptions.length === 0 ? <option value="" disabled>—</option> : netOptions.map(name => <option key={name} value={name}>{name}{netFlagged.has(name) ? ` — ${t('linkDialog.caseFlag')}` : ''}</option>)}</select></div>
            <button type="button" className="primary-button" data-testid="alias-net-create" disabled={!netFrom || !netTo} onClick={createNet}><Link2 size={14} />{t('linkDialog.createNet')}</button>
            {netHints.length > 0 && <div className="wsp-link-hints" data-testid="alias-net-hints"><span className="muted">{t('linkDialog.fromComparison')}</span>{netHints.map(pair => <button key={pair.board} type="button" className="outline-button" aria-label={t('linkDialog.useBoardNet', { name: pair.board })} onClick={() => { setNetTo(pair.board); setNetFilter(''); }}><span className="mono">{pair.board}</span><span className="muted">{t('linkDialog.evidence', { board: pair.board, count: String(pair.pins) })}</span></button>)}</div>}
            {netFrom && netTo && <p className="wsp-link-consequence" data-testid="alias-net-consequence">{t('linkDialog.netConsequence', { source: netFrom, target: netTo })}{netFlagged.has(netTo) ? ` ${t('linkDialog.caseFlag')}.` : ''}</p>}
          </div>}
        </section>

        <section className="wsp-link-block" aria-labelledby="wsp-link-diff"><h3 id="wsp-link-diff">{t('linkDialog.differences')}</h3>{model.pairs.length > 0 && <p className="settings-hint">{t('linkDialog.diffCaption')}</p>}
          {model.diffPins.length === 0 && model.pairs.length === 0 ? <p className="empty-caption">{t('linkDialog.noDiff')}</p> : <ul className="wsp-link-diff" data-testid="link-differences">
            {list(model.pairs, (pair, i) => <li key={`n${i}`}><span className="mono">{pair.sch}</span><ArrowRight size={12} aria-hidden="true" /><span className="mono">{pair.board}</span><span className="muted">{t('linkDialog.evidence', { board: pair.board, count: String(pair.pins) })}</span>
              <button type="button" className="text-button" onClick={() => { setNetFrom(pair.sch); setNetTo(pair.board); setNetFilter(''); setMessage(''); }}>{t('linkDialog.use')}</button></li>)}
            {list(model.diffPins, (row, i) => <li key={`p${i}`}>{row.status === 'net-differs' ? t('linkDialog.pinDiffer', { ref: row.ref, pin: row.pinNumber, board: orNone(row.boardNet), sch: orNone(row.schematic?.netName ?? '') }) : t('linkDialog.missingPin', { ref: row.ref, pin: row.pinNumber, where: row.status === 'pin-missing-on-board' ? t('linkDialog.pinMissingBoard') : row.status === 'pin-missing-on-schematic' ? t('linkDialog.pinMissingSch') : row.status })}</li>)}
          </ul>}
          {(link.pins.truncated || link.nets.truncated) && <p className="wsp-reason">{t('linkDialog.truncated')}</p>}
        </section>
      </>}

      <section className="wsp-link-block" aria-labelledby="wsp-link-aliases"><h3 id="wsp-link-aliases">{t('linkDialog.confirmed')}</h3>
        {refEntries.length + netEntries.length === 0 ? <p className="empty-caption" data-testid="alias-empty">{t('linkDialog.noAliases')}</p> : <ul className="wsp-alias-list" data-testid="alias-list">
          {refEntries.map(([from, to]) => <li key={`r:${from}`} data-kind="refs"><span className="wsp-chip">{t('linkDialog.refAlias')}</span><span className="mono">{from}</span><ArrowRight size={12} aria-hidden="true" /><span className="mono">{to}</span>
            {issues('ref', from, to).map(issue => <em key={issue.problem} className="wsp-chip warn" data-testid="alias-issue"><AlertTriangle size={10} />{issueText(issue)}</em>)}
            <button type="button" className="tool-button" aria-label={t('linkDialog.removeRef', { source: from, target: to })} data-testid="alias-remove" onClick={() => remove('refs', from)}><Trash2 size={13} /></button></li>)}
          {netEntries.map(([from, to]) => <li key={`n:${from}`} data-kind="nets"><span className="wsp-chip">{t('inspector.colNet')}</span><span className="mono">{from}</span><ArrowRight size={12} aria-hidden="true" /><span className="mono">{to}</span>
            {issues('net', from, to).map(issue => <em key={issue.problem} className="wsp-chip warn" data-testid="alias-issue"><AlertTriangle size={10} />{issueText(issue)}</em>)}
            <button type="button" className="tool-button" aria-label={t('linkDialog.removeNet', { source: from, target: to })} data-testid="alias-remove" onClick={() => remove('nets', from)}><Trash2 size={13} /></button></li>)}
        </ul>}
        <p className="settings-hint">{t('linkDialog.removeHint')}</p>
      </section>
    </div>
    <div className="modal-footer"><button type="button" className="outline-button" data-testid="link-close" onClick={onClose}>{t('common.close')}</button></div>
  </Modal>;
}
