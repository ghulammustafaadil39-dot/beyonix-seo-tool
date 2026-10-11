# TEST-ONLY TLS fixture
Self-signed cert/key for 127.0.0.1, used ONLY by tests/bb-secfix.test.ts to
run a local HTTPS "tenant WordPress" server so the F-04 publish SSRF fix can
be exercised end-to-end through safeFetch. Throwaway key, generated for this
repo's test suite; never used in production, never trusted anywhere.
