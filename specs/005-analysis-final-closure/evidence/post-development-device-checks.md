# Physical-device verification after development

On 2026-09-08 the owner instructed: 「実機確認はスキップして下さい。全ての開発が終了後に行います。」

Status: DEFERRED BY OWNER. These checks are excluded from current development
completion and remain unverified. Desktop WebKit is not physical iPad evidence.

- [ ] Run the locked workload set on an actual supported iPad after development.
- [ ] Collect device/build/fixture-bound raw numeric samples and required traces.
- [ ] Verify all physical H9 rows, including Instruments peak-footprint evidence.
- [ ] Run the final physical browser/runtime interaction and cancellation checks.

T045 still implements and tests the evidence contract. T040 and other tasks with
physical execution requirements close their applicable software work with this
explicit deferral recorded; they must not manufacture a physical PASS packet.
