import assert from "node:assert/strict";
import { test } from "node:test";
import { readSeats, seatLine, seatsOk } from "./seat-guard.mjs";
import { render } from "./pr-clock.mjs";

// A fake GitHub: path (without paging) -> JSON, or an Error to throw.
function fakeGitHub(routes) {
  const seen = [];
  const get = async (path) => {
    seen.push(path);
    const key = path.replace(/[?&]per_page=\d+(&page=\d+)?$/, "");
    const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
    const hit = routes[key];
    if (hit instanceof Error) throw hit;
    if (hit === undefined) throw new Error(`GET ${path}: 404 "Not Found"`);
    return page === 1 ? hit : [];
  };
  return { get, seen };
}

const clean = {
  "/orgs/ourostack/invitations": [],
  "/orgs/ourostack/outside_collaborators": [],
  "/orgs/ourostack/members": [{ login: "arimendelow" }],
  "/orgs/ourostack/repos?type=all": [{ full_name: "ourostack/ouro-ui", visibility: "public" }, { full_name: "ourostack/secret", visibility: "private" }],
  "/repos/ourostack/secret/collaborators?affiliation=outside": [],
  "/repos/ourostack/secret/invitations": [],
  "/orgs/spoonjoy/invitations": [],
  "/orgs/spoonjoy/outside_collaborators": [{ login: "yosefserkez" }, { login: "sudo-clem" }],
  "/orgs/spoonjoy/members": [{ login: "arimendelow" }],
  "/orgs/spoonjoy/repos?type=all": [{ full_name: "spoonjoy/spoonjoy-v2", visibility: "public" }, { full_name: "spoonjoy/sj-api", visibility: "private" }],
  "/repos/spoonjoy/sj-api/collaborators?affiliation=outside": [],
  "/repos/spoonjoy/sj-api/invitations": [],
};

test("one seat, arimendelow's, is green; public outside collaborators are free", async () => {
  const { get, seen } = fakeGitHub(clean);
  const seats = await readSeats(get, ["ourostack", "spoonjoy"]);
  assert.equal(seatLine(seats), "🟢 Seats: 1 (arimendelow)");
  assert.ok(seatsOk(seats));
  assert.ok(!seen.some((p) => p.includes("ouro-ui") || p.includes("spoonjoy-v2")), "public repositories are not read");
});

test("a second org member goes red and is named", async () => {
  const { get } = fakeGitHub({ ...clean, "/orgs/spoonjoy/members": [{ login: "arimendelow" }, { login: "fake-second-member" }] });
  const seats = await readSeats(get, ["ourostack", "spoonjoy"]);
  const line = seatLine(seats);
  assert.match(line, /^🔴 Seats: 2\./);
  assert.match(line, /`fake-second-member` \(spoonjoy member\)/);
  assert.ok(!seatsOk(seats));
});

test("pending org invitations, private outside collaborators and private repo invitations each take a seat", async () => {
  const { get } = fakeGitHub({
    ...clean,
    "/orgs/ourostack/invitations": [{ login: "invitee" }, { login: null, email: "someone@example.com" }],
    "/repos/ourostack/secret/collaborators?affiliation=outside": [{ login: "outsider" }],
    "/repos/spoonjoy/sj-api/invitations": [{ invitee: { login: "repo-invitee" } }],
  });
  const line = seatLine(await readSeats(get, ["ourostack", "spoonjoy"]));
  assert.match(line, /^🔴 Seats: 5\./);
  for (const name of ["invitee", "someone@example.com", "outsider", "repo-invitee"]) assert.ok(line.includes(`\`${name}\``), name);
  assert.ok(!line.includes("secret") && !line.includes("sj-api"), "private repositories stay unnamed");
});

test("the same account in both orgs is one seat", async () => {
  const { get } = fakeGitHub({ ...clean, "/orgs/ourostack/members": [{ login: "arimendelow" }, { login: "Twin" }], "/orgs/spoonjoy/members": [{ login: "arimendelow" }, { login: "twin" }] });
  const line = seatLine(await readSeats(get, ["ourostack", "spoonjoy"]));
  assert.match(line, /^🔴 Seats: 2\./);
  assert.match(line, /ourostack member; spoonjoy member/);
});

test("a token that cannot read membership is never called clear", async () => {
  const { get } = fakeGitHub({ ...clean, "/orgs/spoonjoy/invitations": new Error('GET /orgs/spoonjoy/invitations: 403 "Must have admin rights"') });
  const seats = await readSeats(get, ["ourostack", "spoonjoy"]);
  assert.match(seatLine(seats), /^⚪ Seats: not checked\. The token cannot read spoonjoy's/);
  assert.ok(!seatsOk(seats));
});

test("the pinned issue leads with the seat line", () => {
  const { body } = render([], "2026-11-07T20:00:00Z", { seats: [{ login: "arimendelow", org: "ourostack", why: "member" }] });
  assert.equal(body.split("\n")[0], "🟢 Seats: 1 (arimendelow)");
});
