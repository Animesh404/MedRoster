# Fullstack Take-Home: Clinic Shift Scheduler

**Time:** 4 days from receiving this brief.
**AI tools:** Allowed. The developer is responsible for every line.

## The scenario

A small clinic needs a website to manage staff shifts. A **manager** creates shifts; **staff** (doctors, nurses, receptionists) claim them. The clinic has been tracking everything in a messy spreadsheet — you must import it.

## Core requirements

### 1. Authentication & roles
- Two roles: `manager` and `staff`. Staff have a profession (doctor / nurse / receptionist).
- Staff can only claim/unclaim shifts for themselves. Managers can do everything, including assigning staff to shifts directly.
- Seed at least one manager login and several staff logins, with credentials listed in the README.

### 2. Shift management
- A shift has: date, start time, end time, and role requirements (e.g. "2 nurses + 1 doctor").
- Managers can create, edit, and delete shifts.
- Editing a shift that already has claims is up to you to design. Decide what happens to the people who claimed it, and document your decision.

### 3. Claiming, with business rules
A staff member's claim must be **rejected with a clear error message** if it would violate either of these:
- The shift already has enough people of their profession.
- It overlaps with another shift they've claimed.

These rules must also hold when a **manager** assigns someone, and must be re-validated if a shift's time is edited after being claimed. Client-side-only validation does not count — the server must enforce all of this.

Note that several staff members may be using the website at the same time, so a shift's availability should stay accurate no matter how many people are acting on it at once.

### 4. The dirty import
You're given `staff.csv` and `shifts.csv` — exports from the clinic's old spreadsheet. They contain real-world garbage: duplicates, inconsistent role names, bad dates, impossible times, whitespace, conflicting rows.

- Import must run automatically as part of your seed process, and the deployed website must be pre-populated with the result.
- The website must also let a **manager upload and import a custom CSV file** through the UI, using the same import logic.
- Your website must include an **Import Report page** (manager-only) showing: how many rows were accepted, and for every rejected or merged row — the row, what was wrong, and what you did with it.

### 5. Coverage dashboard
Manager view: a week-at-a-glance showing every shift, its staffing status (fully staffed / partially staffed / empty), and specifically **which roles are still missing**. Must include a way to jump to any week. This view will be checked for responsiveness.

## Stretch goals (optional)
- **Recurring shifts:** a manager can create "every Mon/Wed 08:00–16:00 until date X", then edit or delete a single occurrence without breaking the series.
- **Live updates:** when a shift fills up, other users viewing it see the change without refreshing.

## Deliverables
1. **Live deployed URL** (free tiers like Render / Vercel + Supabase / Fly.io are fine), already seeded via your importer. Note in the README if the host has cold starts.
2. **Git repository** — meaningful commits are preferred.
3. **`DECISIONS.md`** — a brief note on the decisions you made for the various parts of the website, and one thing you'd do differently with more time.
4. **Tests** are appreciated but optional. If included, they should be runnable with a single documented command.
5. **README** with: stack choice, local setup (one command preferred, e.g. `docker compose up`), test instructions, and seeded login credentials.

You may submit before the deadline if you're done. Submission time is not a judging criterion — a well-tested submission on day 4 beats a rushed one on day 2.

## How you'll be judged
The evaluation will be based on the performance, fluidity, and functionality of the website as a whole. Questions about ambiguous requirements are welcome.
