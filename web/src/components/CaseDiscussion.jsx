import { useEffect, useMemo, useRef, useState } from 'react'
import { api, formatDate } from '../api'
import { useLanguage } from '../i18n'

const NO_LABELS = {}   // stable identity, so the memos below don't rerun every render

/* The conversation attached to one anomaly - the other half of a case file.
 * Everything above this on the page is what the system computed; this is what
 * the people responsible for the work have said about it.
 *
 * Deliberately not built like the rest of this app: no cards, no panel
 * borders, no KPI tiles. A thread reads as a column of voices, and wrapping
 * each comment in its own bordered box would make a conversation look like
 * another analytics grid. The only structure is an avatar rail, an indent for
 * replies, and rules between threads. */

const ROLE_INITIAL = { mospi: 'M', state: 'S', district: 'D', agency: 'A', mp: 'P' }

// mirrors ALLOWED_ATTACHMENTS / MAX_ATTACH_PER_COMMENT in api/comments.py -
// the picker filters to what the server will actually take, but the server
// is what enforces it; this is a courtesy, not the check.
const ACCEPT = '.pdf,.jpg,.jpeg,.png,.csv,.txt,.xlsx,.docx'
const MAX_FILES = 5

function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// "2 hours ago" beats a timestamp for a live conversation, but a case record
// still has to survive being read a year later - so anything older than a week
// falls back to the same date format the rest of the app uses.
function timeAgo(iso, t) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return t('just now')
  const mins = Math.round(seconds / 60)
  if (mins < 60) return t(mins === 1 ? '{n} minute ago' : '{n} minutes ago', { n: mins })
  const hours = Math.round(mins / 60)
  if (hours < 24) return t(hours === 1 ? '{n} hour ago' : '{n} hours ago', { n: hours })
  const days = Math.round(hours / 24)
  if (days <= 7) return t(days === 1 ? '{n} day ago' : '{n} days ago', { n: days })
  return formatDate(iso)
}

/** A mention renders as a chip so an addressed desk is visible at a glance in
 * a wall of text. Matching is on the exact role labels the mention menu
 * inserts, so nothing else in a comment can accidentally look like one. */
function CommentBody({ text, roleLabels }) {
  const pattern = useMemo(() => {
    const labels = Object.values(roleLabels)
    if (!labels.length) return null
    const escaped = labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length)
    return new RegExp(`@(${escaped.join('|')})`, 'g')
  }, [roleLabels])

  if (!pattern) return <p className="discussion-body">{text}</p>
  const parts = []
  let last = 0
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    parts.push(<span className="discussion-mention" key={m.index}>@{m[1]}</span>)
    last = m.index + m[0].length
  }
  parts.push(text.slice(last))
  return <p className="discussion-body">{parts}</p>
}

function Composer({ value, onChange, onSubmit, onCancel, placeholder, submitLabel, busy,
                   roleLabels, autoFocus, files, onFiles, internal, onInternal }) {
  const { t } = useLanguage()
  const ref = useRef(null)
  const fileRef = useRef(null)
  const [mentionOpen, setMentionOpen] = useState(false)

  useEffect(() => { if (autoFocus) ref.current?.focus() }, [autoFocus])

  function insertMention(label) {
    const next = `${value.trimEnd()}${value.trim() ? ' ' : ''}@${label} `
    onChange(next)
    setMentionOpen(false)
    ref.current?.focus()
  }

  return (
    <div className="discussion-composer">
      <textarea
        ref={ref}
        className="discussion-input"
        rows={autoFocus ? 2 : 1}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // Ctrl/Cmd+Enter posts - a reviewer writing several replies shouldn't
        // have to reach for the mouse between each one
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onSubmit() }}
      />

      {/* staged documents sit between the words and the controls, so it is
          obvious they go with this comment and not with the thread at large */}
      {onFiles && files.length > 0 && (
        <ul className="discussion-staged">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <span className="discussion-staged-name">{f.name}</span>
              <span className="discussion-staged-size num">{fileSize(f.size)}</span>
              <button
                type="button" className="discussion-staged-remove"
                aria-label={t('Remove {name}', { name: f.name })}
                onClick={() => onFiles(files.filter((_, j) => j !== i))}
              >×</button>
            </li>
          ))}
        </ul>
      )}

      <div className="discussion-composer-actions">
        <div className="discussion-mention-wrap">
          <button
            type="button" className="discussion-chip-btn" aria-haspopup="true" aria-expanded={mentionOpen}
            onClick={() => setMentionOpen((v) => !v)}
          >
            {t('Mention a desk')}
          </button>
          {mentionOpen && (
            <div className="discussion-mention-menu" role="menu">
              {Object.entries(roleLabels).map(([code, label]) => (
                <button type="button" key={code} role="menuitem" onClick={() => insertMention(label)}>
                  {t(label)}
                </button>
              ))}
            </div>
          )}
        </div>

        {onFiles && (
          <>
            <button type="button" className="discussion-chip-btn" onClick={() => fileRef.current?.click()}>
              {t('Attach document')}
            </button>
            <input
              ref={fileRef} type="file" multiple accept={ACCEPT} className="discussion-file-input"
              onChange={(e) => {
                onFiles([...files, ...Array.from(e.target.files || [])].slice(0, MAX_FILES))
                e.target.value = ''   // re-picking the same file must still fire a change
              }}
            />
          </>
        )}

        {onInternal && (
          <label className="discussion-internal-toggle">
            <input type="checkbox" checked={internal} onChange={(e) => onInternal(e.target.checked)} />
            {t('Internal to my desk')}
          </label>
        )}

        <span className="discussion-composer-spacer" />
        {onCancel && (
          <button type="button" className="discussion-chip-btn" onClick={onCancel}>{t('Cancel')}</button>
        )}
        <button
          type="button" className="discussion-post-btn"
          disabled={busy || !value.trim()} onClick={onSubmit}
        >
          {busy ? t('Posting…') : submitLabel}
        </button>
      </div>
    </div>
  )
}

function Comment({ row, me, roleLabels, isReply, onReply, onPatch, onDelete, onDownload, replyingTo, onStartReply, onCancelReply }) {
  const { t, td } = useLanguage()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(row.body)
  const [busy, setBusy] = useState(false)

  const mine = row.author_role === me?.role && row.author_entity === me?.entity
  const roleLabel = roleLabels[row.author_role] || row.author_role
  // a role that signs in per-entity says which one it is - "District Authority"
  // alone is ambiguous when three districts are on the same case
  const entity = row.author_entity ? String(row.author_entity).split('|').pop() : null

  async function save() {
    setBusy(true)
    try { await onPatch(row.id, { body: draft }); setEditing(false) } finally { setBusy(false) }
  }

  if (row.deleted) {
    return (
      <div className={`discussion-comment${isReply ? ' discussion-comment-reply' : ''}`}>
        <span className="discussion-avatar discussion-avatar-gone" aria-hidden="true">—</span>
        <div className="discussion-main">
          <p className="discussion-body discussion-withdrawn">{t('This comment was withdrawn.')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className={`discussion-comment${isReply ? ' discussion-comment-reply' : ''}`}>
      <span className="discussion-avatar" aria-hidden="true">{ROLE_INITIAL[row.author_role] || '?'}</span>
      <div className="discussion-main">
        <div className="discussion-meta">
          <span className="discussion-author">{t(roleLabel)}</span>
          {entity && <span className="discussion-entity">{td(entity)}</span>}
          <span className="discussion-time">{timeAgo(row.created_at, t)}</span>
          {row.edited_at && <span className="discussion-time">{t('edited')}</span>}
          {row.pinned && <span className="discussion-flag">{t('Pinned')}</span>}
          {row.resolved && <span className="discussion-flag discussion-flag-resolved">{t('Resolved')}</span>}
          {row.internal && (
            <span className="discussion-flag discussion-flag-internal" title={t('Visible only to your desk and MoSPI')}>
              {t('Internal')}
            </span>
          )}
        </div>

        {editing ? (
          <Composer
            value={draft} onChange={setDraft} onSubmit={save}
            onCancel={() => { setDraft(row.body); setEditing(false) }}
            placeholder={t('Write a comment…')} submitLabel={t('Save changes')}
            busy={busy} roleLabels={roleLabels} autoFocus
          />
        ) : (
          <CommentBody text={row.body} roleLabels={roleLabels} />
        )}

        {!editing && row.attachments?.length > 0 && (
          <ul className="discussion-attachments">
            {row.attachments.map((a) => (
              <li key={a.id}>
                <button
                  type="button" className="discussion-attachment"
                  onClick={() => onDownload(row.id, a)}
                >
                  <span className="discussion-attachment-name">{a.filename}</span>
                  <span className="discussion-attachment-size num">{fileSize(a.size)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {!editing && (
          <div className="discussion-actions">
            {!isReply && (
              <button type="button" onClick={() => onStartReply(row.id)}>{t('Reply')}</button>
            )}
            <button type="button" onClick={() => onPatch(row.id, { pinned: !row.pinned })}>
              {row.pinned ? t('Unpin') : t('Pin')}
            </button>
            {!isReply && (
              <button type="button" onClick={() => onPatch(row.id, { resolved: !row.resolved })}>
                {row.resolved ? t('Reopen') : t('Resolve')}
              </button>
            )}
            {mine && (
              <button type="button" onClick={() => onPatch(row.id, { internal: !row.internal })}>
                {row.internal ? t('Make visible to all') : t('Mark internal')}
              </button>
            )}
            {mine && <button type="button" onClick={() => { setDraft(row.body); setEditing(true) }}>{t('Edit')}</button>}
            {mine && <button type="button" className="discussion-danger" onClick={() => onDelete(row.id)}>{t('Delete')}</button>}
          </div>
        )}

        {replyingTo === row.id && (
          <ReplyComposer
            onSubmit={(body, files, internal) => onReply(body, row.id, files, internal)}
            onCancel={onCancelReply} roleLabels={roleLabels}
          />
        )}
      </div>
    </div>
  )
}

function ReplyComposer({ onSubmit, onCancel, roleLabels }) {
  const { t } = useLanguage()
  const [value, setValue] = useState('')
  const [files, setFiles] = useState([])
  const [internal, setInternal] = useState(false)
  const [busy, setBusy] = useState(false)
  async function submit() {
    if (!value.trim()) return
    setBusy(true)
    try { await onSubmit(value, files, internal); setValue(''); setFiles([]); setInternal(false) }
    finally { setBusy(false) }
  }
  return (
    <div className="discussion-reply-composer">
      <Composer
        value={value} onChange={setValue} onSubmit={submit} onCancel={onCancel}
        placeholder={t('Write a reply…')} submitLabel={t('Post reply')}
        busy={busy} roleLabels={roleLabels} autoFocus
        files={files} onFiles={setFiles} internal={internal} onInternal={setInternal}
      />
    </div>
  )
}

export function CaseDiscussion({ workNumber, scopeHouse, scopeTenure }) {
  const { t } = useLanguage()
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState([])
  const [internal, setInternal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [replyingTo, setReplyingTo] = useState(null)
  const [newestFirst, setNewestFirst] = useState(true)
  const [query, setQuery] = useState('')

  function load() {
    api.comments(workNumber, scopeHouse, scopeTenure)
      .then((d) => { setData(d); setError(null) })
      .catch((e) => setError(e.message))
  }
  useEffect(load, [workNumber, scopeHouse, scopeTenure])   // eslint-disable-line react-hooks/exhaustive-deps

  const roleLabels = data?.mentionable || NO_LABELS

  // group into threads: a root and its replies, replies always oldest-first
  // (a conversation reads forwards) whatever order the roots are shown in.
  const threads = useMemo(() => {
    const rows = data?.items || []
    const roots = rows.filter((r) => !r.parent_id)
    const byParent = {}
    for (const r of rows) if (r.parent_id) (byParent[r.parent_id] ||= []).push(r)
    const ordered = [...roots].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1   // pinned always leads
      const d = new Date(b.created_at) - new Date(a.created_at)
      return newestFirst ? d : -d
    })
    const all = ordered.map((root) => ({ root, replies: byParent[root.id] || [] }))

    // Searching keeps whole threads, never loose comments: a reply that matches
    // is meaningless torn off the question it answers, so a hit anywhere in a
    // thread keeps the thread. Matches on the words, the desk that wrote them,
    // and any attached document's name.
    const q = query.trim().toLowerCase()
    if (!q) return all
    const hit = (r) => !r.deleted && (
      r.body.toLowerCase().includes(q)
      || (roleLabels[r.author_role] || '').toLowerCase().includes(q)
      || String(r.author_entity || '').toLowerCase().includes(q)
      || (r.attachments || []).some((a) => a.filename.toLowerCase().includes(q))
    )
    return all.filter(({ root, replies }) => hit(root) || replies.some(hit))
  }, [data, newestFirst, query, roleLabels])

  const total = (data?.items || []).filter((r) => !r.deleted).length

  async function post(body, parentId = null, attachFiles = [], isInternal = false) {
    setReplyingTo(null)
    const mentions = Object.entries(roleLabels)
      .filter(([, label]) => body.includes(`@${label}`))
      .map(([code]) => code)
    const created = await api.addComment({
      work_number: String(workNumber), scope_house: scopeHouse, scope_tenure: scopeTenure,
      body, parent_id: parentId, mentions, internal: isInternal,
    })
    // the comment is posted before its documents, so a rejected file (wrong
    // type, too large) costs the attachment and not the words - say which one
    // failed rather than losing what was written
    const failed = []
    for (const f of attachFiles) {
      try { await api.attachToComment(created.id, f) } catch (e) { failed.push(`${f.name}: ${e.message}`) }
    }
    load()
    // reported, never thrown: the comment did post, so the composer must still
    // clear - a draft left sitting there invites the same comment twice
    setError(failed.length
      ? t('Posted, but {n} document(s) were not attached — {detail}', {
          n: failed.length, detail: failed.join('; '),
        })
      : null)
  }

  async function submitTop() {
    if (!draft.trim()) return
    setBusy(true)
    setError(null)
    try {
      await post(draft, null, files, internal)
      setDraft(''); setFiles([]); setInternal(false)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  async function download(commentId, attachment) {
    try { await api.downloadAttachment(commentId, attachment.id, attachment.filename) }
    catch (e) { setError(e.message) }
  }

  async function patch(id, changes) {
    try { await api.updateComment(id, changes); load() } catch (e) { setError(e.message) }
  }
  async function remove(id) {
    try { await api.deleteComment(id); load() } catch (e) { setError(e.message) }
  }

  return (
    <section className="discussion" aria-labelledby="discussion-heading">
      <div className="discussion-head">
        <h2 id="discussion-heading">{t('Discussion')}</h2>
        <p className="discussion-lede">{t('What the desks responsible for this work are saying about it.')}</p>
        {total > 1 && (
          <div className="discussion-head-controls">
            {/* only once a thread is long enough to be worth searching - on a
                case with three comments this is furniture, not a tool */}
            {total > 4 && (
              <input
                type="search" className="discussion-search" value={query}
                placeholder={t('Search this discussion')}
                aria-label={t('Search this discussion')}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
            <button type="button" className="discussion-sort" onClick={() => setNewestFirst((v) => !v)}>
              {newestFirst ? t('Newest first') : t('Oldest first')}
            </button>
          </div>
        )}
      </div>

      <Composer
        value={draft} onChange={setDraft} onSubmit={submitTop}
        placeholder={t('Ask a question or record what you found…')}
        submitLabel={t('Post comment')} busy={busy} roleLabels={roleLabels}
        files={files} onFiles={setFiles} internal={internal} onInternal={setInternal}
      />

      {error && <p className="discussion-error" role="alert">{error}</p>}

      {data === null ? (
        <p className="discussion-empty">{t('Loading discussion')}…</p>
      ) : threads.length === 0 ? (
        <p className="discussion-empty">
          {query.trim()
            ? t('No comment here matches “{q}”. Clear the search to see the whole discussion.', { q: query.trim() })
            : t('No one has commented yet. Start the discussion for this case.')}
        </p>
      ) : (
        <div className="discussion-threads">
          {threads.map(({ root, replies }) => (
            <div className={`discussion-thread${root.resolved ? ' discussion-thread-resolved' : ''}`} key={root.id}>
              <Comment
                row={root} me={data.me} roleLabels={roleLabels} isReply={false}
                onReply={post} onPatch={patch} onDelete={remove} onDownload={download}
                replyingTo={replyingTo} onStartReply={setReplyingTo} onCancelReply={() => setReplyingTo(null)}
              />
              {replies.map((reply) => (
                <Comment
                  key={reply.id} row={reply} me={data.me} roleLabels={roleLabels} isReply
                  onReply={post} onPatch={patch} onDelete={remove} onDownload={download}
                  replyingTo={replyingTo} onStartReply={setReplyingTo} onCancelReply={() => setReplyingTo(null)}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
