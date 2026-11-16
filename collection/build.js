// Builds collection.json. Each request = name, method, path, optional body/headers, and a test script.
const J = { key: 'Content-Type', value: 'application/json' };
const A = { key: 'Accept', value: 'application/json' };
const AUTH = { key: 'Cookie', value: 'token={{token}}' };
const booking = (first, price) => JSON.stringify({
  firstname: first, lastname: 'Tester', totalprice: price, depositpaid: true,
  bookingdates: { checkin: '2027-01-01', checkout: '2027-01-05' }, additionalneeds: 'Breakfast'
}, null, 2);

const reqs = [
  ['01 Health check', 'GET', '/ping', null, [], `
pm.test("API is up (201)", () => pm.response.to.have.status(201));`],

  ['02 Login - valid credentials', 'POST', '/auth', '{\n  "username": "admin",\n  "password": "password123"\n}', [J], `
pm.test("Status is 200", () => pm.response.to.have.status(200));
const body = pm.response.json();
pm.test("Response has a non-empty token", () => {
  pm.expect(body.token).to.be.a("string").and.not.be.empty;
});
// Save the token so later requests can use {{token}}
pm.collectionVariables.set("token", body.token);`],

  ['03 Login - wrong password (negative)', 'POST', '/auth', '{\n  "username": "admin",\n  "password": "wrong"\n}', [J], `
const body = pm.response.json();
pm.test("No token is issued", () => pm.expect(body).to.not.have.property("token"));
pm.test("Reason is 'Bad credentials'", () => pm.expect(body.reason).to.eql("Bad credentials"));`],

  ['04 Create booking', 'POST', '/booking', booking('Asha', 150), [J, A], `
pm.test("Status is 200", () => pm.response.to.have.status(200));
const body = pm.response.json();
pm.test("Returns a numeric bookingid", () => pm.expect(body.bookingid).to.be.a("number"));
pm.test("Echoes back what we sent", () => {
  const sent = JSON.parse(pm.request.body.raw);
  pm.expect(body.booking).to.eql(sent);
});
// Save the id so later requests can use {{bookingId}}
pm.collectionVariables.set("bookingId", body.bookingid);`],

  ['05 Get booking', 'GET', '/booking/{{bookingId}}', null, [A], `
pm.test("Status is 200", () => pm.response.to.have.status(200));
const body = pm.response.json();
pm.test("Has the expected shape", () => {
  pm.expect(body).to.have.all.keys("firstname", "lastname", "totalprice", "depositpaid", "bookingdates", "additionalneeds");
  pm.expect(body.bookingdates).to.have.all.keys("checkin", "checkout");
});
pm.test("Is the booking we created", () => {
  pm.expect(body.firstname).to.eql("Asha");
  pm.expect(body.totalprice).to.eql(150);
});`],

  ['06 Update booking without token (negative)', 'PUT', '/booking/{{bookingId}}', booking('Hacker', 1), [J, A], `
pm.test("Rejected with 403", () => pm.response.to.have.status(403));`],

  ['07 Update booking (full)', 'PUT', '/booking/{{bookingId}}', booking('Asha', 200), [J, A, AUTH], `
pm.test("Status is 200", () => pm.response.to.have.status(200));
pm.test("Price is updated to 200", () => pm.expect(pm.response.json().totalprice).to.eql(200));`],

  ['08 Update booking (partial)', 'PATCH', '/booking/{{bookingId}}', '{\n  "additionalneeds": "Late checkout"\n}', [J, A, AUTH], `
pm.test("Status is 200", () => pm.response.to.have.status(200));
const body = pm.response.json();
pm.test("Only additionalneeds changed", () => {
  pm.expect(body.additionalneeds).to.eql("Late checkout");
  pm.expect(body.totalprice).to.eql(200);
  pm.expect(body.firstname).to.eql("Asha");
});`],

  ['09 Delete booking', 'DELETE', '/booking/{{bookingId}}', null, [AUTH], `
pm.test("Deleted (this API answers 201)", () => pm.response.to.have.status(201));`],

  ['10 Get deleted booking (negative)', 'GET', '/booking/{{bookingId}}', null, [A], `
pm.test("Booking is gone (404)", () => pm.response.to.have.status(404));`],
];

const collection = {
  info: {
    name: 'Restful-Booker API Tests',
    description: 'Practice suite for the Restful-Booker demo API. Run the requests in order: login saves {{token}}, create saves {{bookingId}}, and later requests reuse them.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    { key: 'baseUrl', value: 'https://restful-booker.herokuapp.com' },
    { key: 'token', value: '' },
    { key: 'bookingId', value: '' },
  ],
  item: reqs.map(([name, method, path, body, header, test]) => ({
    name,
    event: [{ listen: 'test', script: { type: 'text/javascript', exec: test.trim().split('\n') } }],
    request: {
      method, header, url: '{{baseUrl}}' + path,
      ...(body ? { body: { mode: 'raw', raw: body, options: { raw: { language: 'json' } } } } : {}),
    },
  })),
};
require('fs').writeFileSync('collection.json', JSON.stringify(collection, null, 2));
