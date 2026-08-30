# ARM64 exception-return presentation regression

This focused regression keeps `ERETAA`/`ERETAB` in the system/exception-return presentation family and keeps `RETAA`/`RETAB` in ordinary authenticated return flow. It exists to prevent a future category-table regression from conflating the two instruction families.
