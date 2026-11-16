# Restful-Booker API notes
Base URL: https://restful-booker.herokuapp.com

- GET /ping -> 201 when healthy.
- POST /auth  body {"username":"admin","password":"password123"} -> 200 {"token":"..."}.
  Wrong credentials -> 200 {"reason":"Bad credentials"}.
- GET /booking -> 200 array of {"bookingid": number}.
  Optional query filters: firstname, lastname (exact match, can be combined).
- POST /booking  headers Content-Type + Accept: application/json
  body {"firstname","lastname","totalprice":number,"depositpaid":boolean,
        "bookingdates":{"checkin":"YYYY-MM-DD","checkout":"YYYY-MM-DD"},"additionalneeds"}
  -> 200 {"bookingid": number, "booking": {...same fields}}.
- GET /booking/{id}  header Accept: application/json -> 200 booking, 404 if missing.
- PUT /booking/{id} (full) and PATCH /booking/{id} (partial) need header "Cookie: token=<token>"; 403 without it.
- DELETE /booking/{id} needs the same Cookie header -> 201 on success.
