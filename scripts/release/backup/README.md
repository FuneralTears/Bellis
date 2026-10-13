# backup/

Validation of the backup a person made before a release: it has to be newer than the last migration applied and contain the `public` and `private` schemas. The tooling never makes the backup and never asks for a password.

`auth` and `vault` are not covered: known debt.

Empty for now (phase 4).
