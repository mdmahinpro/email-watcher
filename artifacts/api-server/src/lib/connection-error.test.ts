import { describe, expect, it } from "vitest";
import { describeConnectionError } from "./mail-scanner";

/**
 * Each branch maps to a genuinely different remedy. The regression risk these
 * guard is a wrong suggestion: pointing at the TLS toggle for a DNS failure, or
 * at DNS for a bad password, wastes an operator's time more than a raw error code
 * would.
 *
 * The strings here are real errors observed while adding mailboxes across a dozen
 * shared-hosting domains.
 */
describe("describeConnectionError", () => {
  describe("certificate problems", () => {
    it("explains a hostname mismatch and names the toggle", () => {
      const err = Object.assign(
        new Error(
          "Hostname/IP does not match certificate's altnames: Host: mail.example.com. is not in the cert's altnames: DNS:*.prod.phx3.secureserver.net",
        ),
        { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
      );

      const message = describeConnectionError(err);

      expect(message).toContain("issued for a different hostname");
      expect(message).toContain("Accept mismatched");
      // The original detail survives, so the actual cert name stays visible.
      expect(message).toContain("secureserver.net");
    });

    it("says expired rather than mismatched for an expired certificate", () => {
      // Previously this claimed the certificate "does not match this hostname",
      // which was simply wrong and confusing.
      const err = Object.assign(new Error("certificate has expired"), {
        code: "CERT_HAS_EXPIRED",
      });

      const message = describeConnectionError(err);

      expect(message).toContain("expired");
      expect(message).not.toContain("different hostname");
      expect(message).toContain("Accept mismatched");
    });

    it("explains a self-signed certificate", () => {
      const err = Object.assign(new Error("self signed certificate"), {
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      });

      expect(describeConnectionError(err)).toContain("Accept mismatched");
    });
  });

  describe("legacy TLS", () => {
    it("explains an unsupported protocol version", () => {
      // Node 24 requires TLS 1.2+. This is not a certificate fault, but the same
      // switch permits it, so the advice must still point there.
      const err = new Error(
        "40CD1A5570730000:error:0A000102:SSL routines:ssl_choose_client_version:unsupported protocol",
      );

      const message = describeConnectionError(err);

      expect(message).toContain("old TLS version");
      expect(message).toContain("Accept mismatched");
      // Must not be mistaken for a certificate mismatch.
      expect(message).not.toContain("different hostname");
    });

    it("explains a wrong version number", () => {
      const err = new Error("wrong version number");

      expect(describeConnectionError(err)).toContain("old TLS version");
    });
  });

  describe("DNS", () => {
    it("explains a nonexistent host without suggesting TLS", () => {
      // No client setting can fix a hostname that does not resolve, so mentioning
      // the certificate toggle here would be actively misleading.
      const err = Object.assign(
        new Error("getaddrinfo ENOTFOUND mail.canavart.com"),
        { code: "ENOTFOUND" },
      );

      const message = describeConnectionError(err);

      expect(message).toContain("does not exist in DNS");
      expect(message).toContain("MX record");
      expect(message).not.toContain("Accept mismatched");
    });
  });

  describe("connection reset", () => {
    it("suggests STARTTLS on 143, verified against a real host", () => {
      // Observed: port 993 reset on every attempt while 143 authenticated.
      const err = Object.assign(new Error("socket hang up"), {
        code: "ECONNRESET",
      });

      const message = describeConnectionError(err);

      expect(message).toContain("port 143");
      expect(message).toContain("STARTTLS");
      expect(message).not.toContain("Accept mismatched");
    });
  });

  describe("timeouts", () => {
    it("explains a connection timeout", () => {
      const err = new Error("Failed to establish connection in required time");

      const message = describeConnectionError(err);

      expect(message).toContain("did not answer in time");
      expect(message).not.toContain("Accept mismatched");
    });
  });

  describe("authentication", () => {
    it("explains rejected credentials and mentions app passwords", () => {
      const err = Object.assign(new Error("Authentication failed."), {
        code: "AUTHENTICATIONFAILED",
      });

      const message = describeConnectionError(err);

      expect(message).toContain("rejected these credentials");
      expect(message).toContain("app password");
      // A password problem must never point at TLS.
      expect(message).not.toContain("Accept mismatched");
    });

    it("recognises 'Invalid credentials' phrasing", () => {
      const err = new Error("Invalid credentials (Failure)");

      expect(describeConnectionError(err)).toContain("rejected these credentials");
    });
  });

  describe("fallback", () => {
    it("returns an unrecognised error unchanged", () => {
      expect(describeConnectionError(new Error("Something novel"))).toBe(
        "Something novel",
      );
    });

    it("handles a non-Error value", () => {
      expect(describeConnectionError("plain string")).toBe("plain string");
      expect(describeConnectionError(undefined)).toBe("undefined");
    });
  });
});
