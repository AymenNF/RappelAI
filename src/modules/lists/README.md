# Lists boundary

M1-06 implements owner-scoped named-list resolution, normalized names, transactional append with list-row locking, and action-key result reuse. Run the service within the executor's transaction; separate actions may intentionally append identical text. See [action execution](../../../docs/action-execution.md).

User CRUD endpoints, edit/delete/reorder and fuzzy-match clarification remain later milestones.
