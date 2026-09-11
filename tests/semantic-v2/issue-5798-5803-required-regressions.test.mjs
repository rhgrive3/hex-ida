// Required-denominator bridge for the #5798/#5803 focused regressions.
// semantic-v2/run.mjs discovers direct *.test.mjs files in this directory,
// so importing the original focused files makes both contracts part of the
// required semantic-v2 gate without duplicating or weakening their assertions.
import '../issue-5798-movz-register-source.mjs';
import '../issue-5803-schema-recovery-open-range.mjs';
