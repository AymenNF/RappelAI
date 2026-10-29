# M2-06: read, edit and complete list items

List commands now run through the local onboarding worker without a model call. They use the user's verified business-phone/sender identity, current consent and confirmed timezone. Stored responses appear in the onboarding simulator and can use the existing injectable reply sender; live WhatsApp sending remains disabled.

## Commands and examples

| Command                                    | Result                                                        |
| ------------------------------------------ | ------------------------------------------------------------- |
| `LISTS`                                    | First ten saved list names and references                     |
| `LIST "Grocery"`                           | First ten items, including their numbers and open/done status |
| `LIST "Grocery" AFTER 10`                  | Items after number 10; follow the returned More command       |
| `ITEM "Grocery" #2`                        | Full text of item 2, including content truncated in summaries |
| `EDIT ITEM "Grocery" "milk" TO "oat milk"` | Preview matching items and the replacement text               |
| `DONE ITEM "Grocery" #2`                   | Preview completion of item 2; `COMPLETE ITEM` also works      |
| `CHOOSE LIST <choice reference> 2`         | Select and confirm option 2 from the latest menu              |

Quote names and text with ordinary double quotes. Escaped quotes inside text use JSON-style `\"`. List references can replace names: `LIST @0123456789abcdef`. `LISTS` supplies its next-page command as `LISTS AFTER <list reference>`. Item numbers are permanent append positions, not temporary positions within a search result. The number after `CHOOSE LIST` is the **menu option**, which can differ from the displayed item number.

For example, if Grocery contains “oat milk” and “almond milk,” asking to edit “milk” shows both. Nothing changes until the user chooses one. Even an exact single-item edit/completion shows a confirmation menu, so the user can see the current target before applying it. The menu lasts 15 minutes. A full `ITEM` read can inspect a long candidate without consuming the menu.

If a list name itself is ambiguous or misspelled, the user first chooses the list. An edit/completion then asks for the item separately. Exact normalized names win over partial/typo suggestions. Duplicate items remain distinct and are never silently merged. More than five candidates asks for a narrower name or item number instead of choosing a subset and guessing.

Editing replaces the text and preserves the item's completion status and position. Completing an already completed item, or saving the same text, returns a no-op receipt without incrementing revisions. There is no deletion, reopening, list renaming, item reordering or bulk edit in this milestone.

## Matching and reading limits

Matching normalizes Unicode compatibility characters, letter case and repeated whitespace. It first checks exact matches, then literal substring matches and a bounded typo distance (at most one change for short queries, two for longer queries). Suggestions always require user selection; there is no model-based confidence threshold that silently authorizes a write.

Search examines at most 1,000 candidate rows. If a list/catalog exceeds that limit, the command asks for an exact list name/reference or item number. It does not claim a unique match from a partial scan. Reads use keyset pages of ten rows; long item previews are shortened without splitting Unicode characters. `ITEM` returns the full text. Concurrent additions may appear on a later page or after restarting `LISTS`; pagination is not an immutable snapshot across separate commands.

Reads show committed state. If an earlier request is still queued in model/execution processing, the response says so. Edits, completion and choice consumption are blocked until that earlier work finishes, preserving ordered business changes. The user retries the command afterward; a blocked attempt does not silently schedule an edit for later. With the model disabled, earlier unprocessed model work may require fixture processing or the existing work-recovery workflow first.

The model's frozen `decision-v1` tools and 60 evaluation cases are unchanged. Natural-language creation still goes through the existing add-list-item plan. The commands above handle management deterministically; general free-form editing requires a future model contract and evaluation update.

## Stale choices, concurrency and identity

Every choice binds exact list/item IDs and revisions to that user's consent/timezone snapshots. A new edit/completion request supersedes older pending menus. A newly issued clarification menu also supersedes the previous menu for that user. Simple catalog/list/item reads do not discard an existing menu.

Adding, editing or completing an item increments the list revision. Changing item content/completion also increments the item's revision. Consequently, an older menu is rejected after an append or edit, even if the chosen item's number still exists. This is deliberately conservative: ask again and review current state. Missing, foreign, expired, consumed and stale references produce a generic unavailable/out-of-date response without exposing another user's data. STOP or a pending/confirmed timezone change invalidates outstanding menus.

The handler locks user, choice, list and item in that order. The existing add service locks the list before inserting. Choice expiry and revision are rechecked after waiting for that list lock. Competing consumers can apply a choice only once, and parallel additions cannot be overwritten by an edit. A failure or expired work lease rolls back the item, revisions, choice consumption, action receipt and identity reply together.

Each ingress event has one immutable action receipt. Replaying that event returns its saved response rather than editing twice or returning a newer read snapshot. A separate event using the consumed choice is stale. Changed items also suppress any queued original add confirmation that would describe outdated content; the original creation receipt remains historical evidence.

## Database changes

Migration `0015_list_management.sql` adds:

| Data                           | Purpose                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `lists.reference` / `revision` | Stable public selector and list-content revision; indexed owner/reference pagination                          |
| `list_items.revision`          | Optimistic version of text/completion; trigger increments it on actual changes                                |
| `list_choices`                 | Owner-bound request, identity snapshots, status, reference and 15-minute deadline                             |
| `list_choice_options`          | Up to five fixed options with owner-aware list/item foreign keys and captured revisions                       |
| `list_actions`                 | Immutable per-event outcome/reply; mutation receipts also store before/after content, completion and revision |

An insert/update trigger increments the parent list revision, including additions through the existing execution service. All three new tables force tenant RLS. Ingress cannot read them. Tenants can read their own data but cannot change item contents or forge choices/receipts. Workers receive column-level item text/completion access, parent revision updates and choice-status updates; item positions and receipt content remain protected. Event-owner triggers bind receipts to the actual verified phone/sender. As before, the shared worker role is trusted across tenants; see [tenant isolation](tenant-isolation.md).

## Local setup and verification

Stop older workers, run `npm run db:migrate`, then rebuild/restart the worker. No new provider credentials or environment variables are needed. `npm run onboarding:chat` displays stored command replies for that simulator's synthetic user; its lists must belong to the same identity. Fixture model mode generates clarification rather than arbitrary list additions. Integration fixtures create synthetic saved lists through the real execution service.

Unit tests cover syntax/escaping, malformed commands, Unicode normalization, typo/substring matching, duplicate preservation and bounded previews. Restricted-login PostgreSQL tests cover paginated reads, two-stage clarification, duplicates, exact-match precedence, no-match/too-many results, stale/expired/superseded/foreign choices, replay and simultaneous consumption, append/edit races, expiry during a lock wait, no-op completion, queued-work ordering, lease/transaction rollback, STOP/settings changes, large-list limits, immutable receipts and RLS/FK/grant isolation.

Live sending and paid model calls remain disabled. Next is **M2-07: digest/quiet-hour preferences with an explicit delivery promise**, so exact-time reminders are not silently delayed. The beginner PDF remains the M1-08 historical snapshot.

`npm run test:integration` runs at most two test files simultaneously to stay within the local PostgreSQL connection limit. Concurrent operations inside individual race tests still run in parallel.
