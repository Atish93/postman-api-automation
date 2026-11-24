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

## Known API bug: GET /user/login returns its session message as raw text labelled Content-Type application/json, which is not valid JSON, although the contract says application/json with schema string.
Direct probe with real seeded credentials and no unresolved variables: GET /user/login?username=user1&password=XXXXXXXXXXX with Accept: application/json returns 200, Content-Type application/json, body `Logged in user session: 5415229380296914791`. That is raw text, not valid JSON, so JSON parsing fails ("Unexpected token 'L'"). Contract violation: 200 content application/json has schema {type: string}, so the body should be a JSON string literal, e.g. "\"Logged in user session: ...\"". The unresolved {{username}}/{{password}} in the collection is a separate test defect (the username and password environment variables should be set), but it does not cause this failure: the body is identical with valid credentials.
Found 2026-11-23 in "TC11 Log in with a valid username and password" (Petstore Test).

## Known API bug: GET /user/login never checks credentials: a wrong password or a user that does not exist still gets 200 and a session token, although the contract documents 400 for invalid username/password.
Direct probe with an existing seeded user: GET /user/login?username=user1&password=wrong-password-xyz returns 200 "Logged in user session: 7831645696840774914". Contract violation: GET /user/login responses say '400: Invalid username/password supplied'. The unresolved {{username}} is a separate test defect: set the username environment variable so the test really sends an existing user. Fixing it would not change the result, because a real user with a wrong password also gets 200.
Found 2026-11-23 in "TC12 Log in with a wrong password" (Petstore Test).

## Known API bug: GET /user/login on petstore3.swagger.io returns 200 and a session for any username and password, even ones that do not exist or are missing, and never the documented 400 "Invalid username/password supplied".
Direct probe: GET /user/login?username=nonexistent_user_zz9&password=whatever returned 200 with the body "Logged in user session: 3956666403132616035". GET /user/login with no parameters also returned 200 with a session. Contract violation: GET /user/login documents 400 "Invalid username/password supplied", but the API accepts any credentials, including none. The test's URL, parameters and expected value match the contract.
Found 2026-11-23 in "KNOWN BUG - TC13 Log in with a username that does not exist" (Petstore Test).
