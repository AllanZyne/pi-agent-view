# How the Codex CLI TUI implements `@` mention autocomplete

Investigated against a shallow clone of `github.com/openai/codex` (commit at
clone time; `codex-rs` workspace). All paths below are relative to
`codex-rs/` unless stated otherwise. Codex has no separate concept called
"agent mention" in its `@` popup; the closest analogue is a **Task** mention,
which links to another conversation thread (`thread://<id>`), so findings
below describe files, skills, plugins, apps/connectors, and tasks/threads —
the full set of things Codex's unified `@` popup actually merges.

## a. Data model for "a thing you can mention with `@`"

- Codex has **two coordinated systems**, gated by a `mentions_v2_enabled`
  flag documented in the module doc-comment at the top of
  `tui/src/bottom_pane/chat_composer.rs` (lines 15-19): "By default, `@`
  lists plugins, filesystem entries, and skills... Disabling `mentions_v2`
  restores file-only `@` search and adds plugins back to `$`."

- When `mentions_v2` is enabled, there **is** a single unified data model:
  `Candidate` in `tui/src/bottom_pane/mentions_v2/candidate.rs` (lines
  55-64), carrying an explicit discriminant `mention_type: MentionType` (an
  enum `Plugin | Skill | Task | File | Directory`, lines 19-25 of the same
  file) and an explicit `selection: Selection` field, where `Selection` is
  itself an enum (lines 12-18): `Selection::File(PathBuf)` or
  `Selection::Tool { insert_text: String, path: Option<String> }`. Skills,
  plugins, and tasks are converted into `Candidate` values by
  `build_search_catalog` in `tui/src/bottom_pane/mentions_v2/search_catalog.rs`
  (lines 14-61); filesystem matches (`File`/`Directory`) are converted from
  `codex_file_search::FileMatch` by `file_match_to_row` in
  `tui/src/bottom_pane/mentions_v2/filter.rs` (lines 92-107). Every candidate
  therefore carries its kind and its concrete selection payload from the
  moment it is constructed, not derived later from a string.

- When `mentions_v2` is disabled, Codex genuinely falls back to **separate,
  older code paths that must coordinate manually**: `ActivePopup` (defined in
  `tui/src/bottom_pane/chat_composer/popup_state.rs`, lines 106-113) has
  distinct variants `File(FileSearchPopup)` (plain filesystem-only `@`
  search) and `Skill(SkillPopup)` (skills+plugins+apps under `$`, built by
  `MentionItem`, `tui/src/bottom_pane/skill_popup.rs` lines 19-27, which uses
  a `category_tag: Option<String>` display label such as `"[Skill]"`,
  `"[Plugin]"`, `"[App]"` rather than a real enum). `ChatComposer::mention_items`
  (`tui/src/bottom_pane/chat_composer.rs`, lines 4225-4322) manually builds
  that `Vec<MentionItem>` from `self.skills`, `self.plugins`, and
  `self.connectors_snapshot` in three separate loops.

- The `ActivePopup` enum (`popup_state.rs`, lines 106-113) has a fourth
  file-search-only variant `File(FileSearchPopup)` and a fifth
  `MentionV2(MentionV2Popup)` for the unified mode, confirming both systems
  literally coexist in the same struct as of this snapshot of the repo.

## b. Detecting "cursor is inside a mention token"

- Token detection is **not** restricted to the start of a line or message.
  It runs from the current cursor byte offset outward to the nearest
  whitespace on each side, treating any `@word`/`$word` substring anywhere in
  the buffer as a candidate token. This is implemented in
  `current_prefixed_token_range_with_dollar_predicate`,
  `tui/src/bottom_pane/chat_composer/completion_target.rs` (lines 79-224):
  it slices `before_cursor`/`after_cursor` around `safe_cursor`, walks
  backward/forward to the nearest whitespace boundary (`is_horizontal_whitespace`,
  lines 105-111) to get `start_left..end_left` and `start_right..end_right`,
  and only then checks whether either side's slice `starts_with(prefix)`.

- Line breaks are explicitly excluded from being "whitespace that starts a
  token": `is_horizontal_whitespace` (lines 105-111) matches ordinary spaces
  but excludes `\n`, `\r`, and other vertical whitespace, and the module
  doc-comment on `chat_composer.rs` (line 45) states "It also inserts a space
  rather than crossing a line break," confirming mentions never span a
  newline but are otherwise unconstrained in position.

- Atomic "text elements" already inserted into the buffer (previously
  completed mentions, pasted-content placeholders, slash commands) act as
  hard boundaries that a new mention token cannot straddle: this is enforced
  in `prefixed_candidate_range` (`completion_target.rs`, lines 13-62), which
  iterates `textarea.text_element_ranges_overlapping(range)` and clips the
  candidate segment at the element's edge, and in
  `prefixed_token_range_is_editable` (lines 254-274), which returns `false`
  (not editable / not a live token) if `textarea.element_id_for_exact_range`
  finds an existing atomic element occupying that exact span.

- This whitespace-delimited, cursor-relative scan is invoked on every key
  press: `ChatComposer::sync_popups` (`chat_composer.rs`, line 3927 onward)
  calls `self.current_mentions_v2_token_range()` (line 3944) — which itself
  calls `current_editable_at_token_range_with_options` /
  `current_prefixed_token_range_with_dollar_predicate` — after each handled
  key event, per the module doc-comment: "After every handled key, we call
  `ChatComposer::sync_popups` so UI state follows the latest buffer/cursor"
  (`chat_composer.rs`, line 33).

## c. Applying a selection back into the buffer; is the "kind" ever ambiguous?

- Selection is never inferred from surrounding text; it is read off the
  explicit `Selection`/`MentionV2Selection` value returned by
  `popup.selected()` and dispatched by a `match`, in
  `handle_key_event_with_mentions_v2_popup`
  (`tui/src/bottom_pane/chat_composer.rs`, lines 2373-2385):
  `MentionV2Selection::File(path) => self.insert_selected_file_path(...)` vs.
  `MentionV2Selection::Tool { insert_text, path } => self.insert_selected_mention(...)`.
  The branch taken — and therefore how the text is spliced in — is decided
  purely by which enum variant the selected `Candidate` carried, set once at
  `Candidate`/`SearchResult` construction time (see part a).

- For the legacy `$`/non-v2 `Skill` popup, `MentionItem` has no enum kind at
  all — only a free-form `category_tag: Option<String>` used solely for
  display (`skill_popup.rs`, lines 19-27, and its use as a row label in
  `rows_from_matches`, lines 128-140 onward). All `MentionItem`s funnel
  through a single insertion function, `insert_selected_mention`
  (`chat_composer.rs`, lines 2788-2833), so there is no branching by kind on
  this path — the `insert_text` string (e.g. `"$skill-name"` or
  `"@Plugin-Name"`) and an optional `path` are simply inserted as one atomic
  element and, if `path` is present, recorded in a binding map (see part d).

## d. Does a token's "kind" ever get re-derived from raw text near the cursor?

- Codex avoids re-deriving *classification* (which resource a mention points
  at) from text, but it does re-derive the *sigil and bare name* from the
  literal inserted text in one place, purely to reconstruct a lookup key —
  not to decide meaning. `mention_token_from_insert_text`
  (`chat_composer.rs`, lines 2861-2879) parses the leading `$`/`@` character
  and the following mention-name characters back out of `insert_text`
  strings like `"$skill-name"`. It is used by
  `current_mention_elements` (lines 2881-2898) to compute `(id, sigil,
  mention)` triples for every atomic text element currently in the buffer,
  purely so those triples can be matched against
  `self.draft.mention_bindings: HashMap<u64, ComposerMentionBinding>` — a
  side table populated once, at insertion time, in `insert_selected_mention`
  (lines 2788-2833), with the authoritative `path` value that came directly
  from the selected `Candidate`/`MentionItem`.

- Concretely, `insert_selected_mention` (lines 2788-2833) inserts
  `insert_text` as one atomic element via `self.draft.textarea.insert_element(insert_text)`,
  which returns a fresh element `id` (`textarea.rs`, `insert_element`, lines
  1726-1735), and then, if a `path` was supplied, immediately writes
  `self.draft.mention_bindings.insert(id, ComposerMentionBinding { sigil,
  mention, path })` (lines 2814-2821). The `id` — not the text — is the
  permanent key that ties an inserted token to its resolved resource; later
  code (`current_mention_elements`, `snapshot_mention_bindings` at line
  2899, `bind_mentions_from_snapshot` at line 2916) always looks the binding
  up by element `id` first and only falls back to re-parsing `sigil`/`mention`
  from the element's current text as a consistency check
  (`current_mention_elements`, lines 2887-2895: it only trusts the binding
  found by `id` when `snapshot.text == format!("{sigil}{mention}", ...)`
  still matches). So the *kind/target* of a mention is carried explicitly
  from selection time onward, keyed by element identity; raw-text
  re-parsing is used only as a same-token integrity check, never as the
  original source of truth for what a token refers to.

- One place raw text genuinely does drive an active decision rather than
  just a consistency check: `dollar_query_kind`
  (`tui/src/bottom_pane/chat_composer/completion_target.rs`, lines 315-336)
  classifies text after a typed `$` (e.g. `ShellVariable`,
  `DefiniteShellParameter`, `AmbiguousShellParameter`, `Completable`) to
  arbitrate between shell-parameter syntax (`$1`, `$HOME`) and a mention
  completion — this is disambiguating *whether something is a mention at
  all*, not which kind of already-selected mention it is, and for the
  ambiguous case it explicitly falls back to checking the live mention
  catalog (`current_mention_target`, lines 2704-2760, calls
  `mention.fuzzy_match_query(query)` against real candidates) rather than
  guessing from the string alone.

## e. Does a completed mention's rendering differ from its underlying text?

- Inside the live composer buffer, no: the underlying editable text and the
  displayed text for a completed mention are the same bytes. `insert_element`
  (`tui/src/bottom_pane/textarea.rs`, lines 1726-1735) inserts the literal
  `insert_text` string (e.g. `"$skill-name"`, `"@Plugin-Name"`) into
  `TextArea.text` and separately records a `TextElement { id, range }` in a
  side vector `self.elements` (struct at lines 116-119) purely to mark that
  byte range as atomic (non-splittable by further edits/backspace/cursor
  movement) — it does not rewrite the text into any bracket/link syntax.
  The struct-level doc-comment for `TextArea` (lines 130-136) calls these
  "placeholder-like text elements that must move atomically with edits,"
  confirming the mechanism is an out-of-band atomicity annotation, not a
  rendering transform.

- A distinct, bracket-link rendering *does* exist, but only at the
  **persisted-history / model-visible text** boundary, not in the live
  composer. `encode_history_mentions_at_elements`
  (`tui/src/mention_codec.rs`, lines 29-121) turns a bound mention such as
  `$skill-name` (or the `@`-sigiled plugin/text form) into
  `[$skill-name](path)` / `[@name](path)` before it leaves the TUI (lines
  100-109: it pushes `'['`, the sigil, the name, `"]("`, the path, then
  `')'`). Task mentions get their own bracket format `[@title](thread://id)`
  via `format_task_link` (`tui/src/task_mentions.rs`, lines 214-221). The
  inverse, `decode_history_mentions_with_at_mentions`
  (`mention_codec.rs`, lines 125-169), parses that bracket syntax back out
  of history text into plain `sigil+name` text plus a `Vec<LinkedMention>`
  (struct at lines 10-14) carrying the recovered `path`.

- This split exists precisely to avoid the cursor-reentry ambiguity the
  investigation asked about: while a mention is a live atomic element in the
  composer, its kind/target is available for free via the `id`-keyed
  `mention_bindings` map (see part d), so no special syntax is needed in the
  live buffer. Once text round-trips through history (serialized, reloaded
  into a fresh `TextArea` with no elements/bindings), the bracket-link
  syntax `[$name](path)`/`[@name](path)` is the only way to recover which
  `path` a given `name` pointed to, and `parse_history_linked_mention`
  (`mention_codec.rs`, lines 178-205) plus rebinding logic
  (`set_text_content_with_mention_bindings`, `chat_composer.rs`, line 1523)
  re-establish fresh `TextElement`s and `mention_bindings` entries from that
  syntax before the cursor can ever re-enter a "finished" token in the
  reloaded draft.
