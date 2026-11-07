// The seat guard: the Ouro Labs enterprise pays for one seat, and only arimendelow may hold it.
// Everyone else is an outside collaborator on public repositories or sends PRs from a fork.
// The rule: agents/one-paid-seat.md.
//
// Whatever consumes a license in ourostack or spoonjoy is a seat:
//   - an organization member,
//   - a pending organization invitation,
//   - an outside collaborator on a private or internal repository,
//   - a pending invitation to a private or internal repository.
// Outside collaborators on public repositories and fork contributors are free.

export const SEAT_OWNER = "arimendelow";
export const SEAT_ORGS = (process.env.SEAT_GUARD_ORGS ?? "ourostack spoonjoy").split(/\s+/).filter(Boolean);

// seats: [{ login, org, why }]. Returns the one line the pinned issue shows.
export function seatLine(result) {
  if (result.unchecked) return `⚪ Seats: not checked. ${result.unchecked}`;
  const byLogin = new Map();
  for (const s of result.seats) {
    const login = s.login.toLowerCase();
    if (!byLogin.has(login)) byLogin.set(login, { login: s.login, why: [] });
    byLogin.get(login).why.push(`${s.org} ${s.why}`);
  }
  const extra = [...byLogin.values()].filter((s) => s.login.toLowerCase() !== SEAT_OWNER);
  if (!extra.length) return `🟢 Seats: ${byLogin.size} (${SEAT_OWNER})`;
  const names = extra.map((s) => `\`${s.login}\` (${[...new Set(s.why)].join("; ")})`).join(", ");
  return `🔴 Seats: ${byLogin.size}. Only ${SEAT_OWNER} may hold a seat: ${names}. Make each an outside collaborator on public repositories only, or remove them.`;
}

export function seatsOk(result) {
  return !result.unchecked && seatLine(result).startsWith("🟢");
}

// Reads every license-consuming account. `get(path)` returns parsed JSON or throws an Error whose
// message holds the HTTP status. A token that cannot read org membership would silently list only
// public members, so the guard first asks for the owner-only lists and reports "not checked" if
// they are refused, rather than calling a partial list clear.
export async function readSeats(get, orgs = SEAT_ORGS) {
  try {
    return await read(get, orgs);
  } catch (err) {
    return { unchecked: `Reading seats failed: ${err.message.slice(0, 160)}` };
  }
}

async function read(get, orgs) {
  const all = async (path) => {
    const out = [];
    for (let page = 1; ; page++) {
      const batch = await get(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) return out;
    }
  };
  const seats = [];
  for (const org of orgs) {
    let invitations;
    try {
      invitations = await all(`/orgs/${org}/invitations`);
      await get(`/orgs/${org}/outside_collaborators?per_page=1`);
    } catch (err) {
      return { unchecked: `The token cannot read ${org}'s members and invitations (${err.message.slice(0, 120)}). It needs org Members: read and repository Administration: read on ourostack and spoonjoy.` };
    }
    for (const m of await all(`/orgs/${org}/members`)) seats.push({ login: m.login, org, why: "member" });
    for (const i of invitations) seats.push({ login: i.login ?? i.email ?? "an email invitation", org, why: "invited to the org" });
    // The issue is public: private repositories are never named.
    for (const repo of await all(`/orgs/${org}/repos?type=all`)) {
      if (repo.visibility === "public") continue;
      const name = repo.full_name;
      for (const c of await all(`/repos/${name}/collaborators?affiliation=outside`))
        seats.push({ login: c.login, org, why: "outside collaborator on a private repository" });
      for (const inv of await all(`/repos/${name}/invitations`))
        seats.push({ login: inv.invitee?.login ?? "an email invitation", org, why: "invited to a private repository" });
    }
  }
  return { seats };
}
