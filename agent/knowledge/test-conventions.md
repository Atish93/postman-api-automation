# Team test conventions

## Naming requests
Number every request with two digits so the run order is obvious: "01 Login", "02 Create booking".
Mark requests that expect a rejection or an empty result with "(negative)" at the end of the name.

## Test data
Never rely on bookings that already exist on the server; the demo data is reset regularly and other people change it.
Create the data each collection needs, with names made unique by a timestamp or random suffix.
Use check-in and check-out dates in the future.

## Cleanup
Every booking a collection creates must be deleted by that collection.
After deleting, add a request that reads the booking again and expects 404, to prove the cleanup worked.

## Order of assertions
In each test script, assert the status code first, then the shape of the body, then specific values.
Give every pm.test a name that says what is expected, for example "Status is 200" or "Only additionalneeds changed".

## Variables
Keep the base URL in a collection variable named baseUrl.
Pass values between requests with pm.collectionVariables, never by hard-coding ids or tokens.

## Known quirks of Restful-Booker
A successful DELETE answers 201, not 200 or 204.
Login with wrong credentials answers 200 with {"reason":"Bad credentials"} instead of 401.
Update and delete without credentials answer 403.
These are the API's real behaviour, so tests assert them as they are.

## Known API bugs
When the knowledge base lists a known API bug, still assert the behaviour the API documentation describes.
The test is meant to fail until the API is fixed; never write a test that expects the buggy behaviour.
