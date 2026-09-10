// Required Phase7 admission wrapper for the full #5698 producer→consumer regression.
// Keep the root fixture as the single test authority; importing it registers its node:test cases.
import '../issue-5698-string-xref-byte-extent.mjs';
