# Known issues found by the debugger

## Known API bug: GET /booking?checkin=YYYY-MM-DD leaves out bookings whose checkin equals the given date (it acts as strictly after), although the docs say on or after.
Docs: checkin filter returns bookings with checkin "greater than or equal to" the date. Created booking 2081 with checkin 2027-01-01. GET /booking?checkin=2027-01-01 returned [{"bookingid":1599}] (2081 missing). GET /booking?checkin=2026-12-31 returned [1599, 2081]. So the filter is strictly greater-than and leaves out same-day check-ins, which contradicts the docs.
Found 2026-11-19 in "05b Filter by checkin date (same day)".

## Test pitfall: PUT /booking/:id returns 403 Forbidden unless a Cookie token=... or Basic Authorization header is sent, so every update request needs the auth header.
The request 07 definition sends only the Content-Type and Accept headers, with no Cookie and no Authorization. Requests 08 and 09 send "Cookie: token={{token}}". Probe: PUT /booking/2081 without a Cookie returned 403 "Forbidden". The same PUT with "Cookie: token=bd3b3839fb149c5" returned 200 with totalprice 200. Docs: PUT needs either a Cookie token or Basic Authorization.
Fix: Add the header "Cookie: token={{token}}" to 07, as 08 and 09 already do.
Found 2026-11-19 in "07 Update booking (full)".

## Test pitfall: DELETE /booking/:id returns 201 Created on success, as documented, not 200.
The docs for DELETE /booking/:id show the response "HTTP/1.1 201 Created". Probe: DELETE /booking/2081 with the Cookie token returned 201 "Created". In the run, the follow-up GET (request 10) returned 404, so the delete works. The test expects 200, which the docs do not support.
Fix: Expect status 201 (Created) for a successful DELETE.
Found 2026-11-19 in "09 Delete booking".

## Test pitfall: Request 08 (PATCH /booking/:id) asserts totalprice 200, which depends on request 07 (PUT) succeeding first. If 07 fails, 08 fails as a consequence, so fix 07 rather than 08.
Request 08 is correct. It failed because 07 never updated the price (07 got 403 for the missing token), so totalprice was still 150. Probe: after an authenticated PUT set totalprice to 200, PATCH /booking/1645 {"additionalneeds":"Late checkout"} with the Cookie token returned 200 with totalprice 200, firstname Asha and additionalneeds "Late checkout". So the PATCH works as documented.
Fix: Do not change 08. Adding the Cookie token header to 07 fixes this.
Found 2026-11-19 in "08 Update booking (partial)".
