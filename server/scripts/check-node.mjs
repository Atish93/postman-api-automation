// Runs before `npm test`: the server needs Node.js 22.13 or newer (its database is Node's built-in SQLite).
// On an older Node every test would fail with "No such built-in module: node:sqlite"; say why once instead.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    `The server's tests need Node.js 22.13 or newer; this is ${process.versions.node}.\n` +
      "With nvm, in the repository folder: nvm install && nvm use   (it reads .nvmrc)",
  );
  process.exit(1);
}
