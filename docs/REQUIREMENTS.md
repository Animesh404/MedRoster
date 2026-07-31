# Requirements

What MedRoster has to do, stated as product requirements. Design decisions and
their reasoning live in [`../DECISIONS.md`](../DECISIONS.md); known gaps live in
[`KNOWN_ISSUES.md`](KNOWN_ISSUES.md).

## The scenario

A small clinic manages staff shifts. A **manager** creates shifts; **staff**
(doctors, nurses, receptionists) claim them. The clinic previously tracked
everything in a spreadsheet, whose contents have to be imported.

## 1. Authentication and roles

- Two roles: `MANAGER` and `STAFF`. Staff have a profession (doctor, nurse or
  receptionist); managers do not.
- Staff can claim and release shifts only for themselves. Managers can do
  everything, including assigning staff to shifts directly.
- The roster is invite-only. Membership is granted by a manager, never by
  self-signup.

## 2. Shift management

- A shift has a date, a start time, an end time, and per-profession
  requirements (for example, two nurses and one doctor).
- Managers can create, edit and delete shifts.
- Editing a shift that already has claims must not silently strand anyone. The
  chosen behaviour — re-validate everything, drop only what genuinely breaks,
  and show the manager exactly who before saving — is documented in
  `DECISIONS.md`, along with the durable notice each dropped member receives.

## 3. Claiming, and the rules that govern it

A claim must be **rejected with a clear message** when it would violate either
rule:

- the shift already has enough people of that profession, or
- it overlaps another shift the same person holds.

Both rules apply equally when a **manager** assigns somebody, and both are
re-checked when a shift's time is edited after being claimed. Enforcement is
server-side; client-side validation is a convenience, never the guarantee.

Several people may act on the same shift at once, so availability must stay
correct under concurrency rather than merely under sequential use.

## 4. Importing the old spreadsheet

`staff.csv` and `shifts.csv` are exports from the clinic's spreadsheet and
contain real-world mess: duplicates, inconsistent profession names, bad dates,
impossible times, stray whitespace, and rows that contradict each other.

- The import runs as part of seeding, so a fresh deployment is already
  populated.
- A manager can also upload a CSV through the UI, which runs the same import
  logic — one implementation, not two.
- A manager-only **import report** shows how many rows were accepted and, for
  every rejected or merged row, the row itself, what was wrong with it, and
  what the importer did about it.

## 5. Coverage dashboard

A manager-facing week view showing every shift, its staffing status (fully
staffed, partially staffed, or empty) and, specifically, **which professions
are still missing**. It must be possible to jump to any week, and the view has
to work on small screens.

## 6. Recurring shifts

A manager can create a repeating pattern — for example every Monday and
Wednesday, 08:00–16:00, until a given date — and then edit or delete a single
occurrence without breaking the rest of the series.

## 7. Live updates

When a shift fills up, other people looking at it see the change without
reloading the page.
