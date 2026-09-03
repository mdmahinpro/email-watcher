import { describe, expect, it } from "vitest";
import { describeConnectionError } from "./mail-scanner";

/**
 * A bare TLS error code tells an operator nothing about what to do, and the
 * mailbox is usually fine — it is the certificate that is wrong. These cover the
 * rewrite that names the remedy.
 */
describe("describeConnectionError", () => {
  it("explains a hostname mismatch and names the fix", () => {
    // The real case: GoDaddy shared hosting serves *.prod.sin2.secureserver.net
    // on mail.<customer-domain>.
    const err = Object.assign(
      new Error(
        "Hostname/IP does not match certificate's altnames: Host: mail.albadrmed.com. is not in the cert's altnames",
      ),
      { code: "ERR_TLS_CERT_ALTNAME_INVALID" },
    );

    const message = describeConnectionError(err);

    expect(message).toContain("does not match this hostname");
    expect(message).toContain("Accept mismatched TLS");
    // The original detail is preserved, not replaced.
    expect(message).toContain("altnames");
  });

  it("explains a self-signed certificate", () => {
    const err = Object.assign(new Error("self signed certificate"), {
      code: "DEPTH_ZERO_SELF_SIGNED_CERT",
    });

    expect(describeConnectionError(err)).toContain("Accept mismatched TLS");
  });

  it("explains an expired certificate", () => {
    const err = Object.assign(new Error("certificate has expired"), {
      code: "CERT_HAS_EXPIRED",
    });

    expect(describeConnectionError(err)).toContain("Accept mismatched TLS");
  });

  it("explains an unverifiable chain", () => {
    const err = Object.assign(
      new Error("unable to verify the first certificate"),
      { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" },
    );

    expect(describeConnectionError(err)).toContain("Accept mismatched TLS");
  });

  it("recognises a certificate problem from the message alone", () => {
    // Some libraries wrap the error and drop the code.
    const err = new Error("certificate verify failed");

    expect(describeConnectionError(err)).toContain("Accept mismatched TLS");
  });

  it("leaves an authentication failure untouched", () => {
    // Suggesting a TLS toggle for a wrong password would send someone down the
    // wrong path entirely.
    const err = Object.assign(new Error("Invalid credentials (Failure)"), {
      code: "AUTHENTICATIONFAILED",
    });

    const message = describeConnectionError(err);

    expect(message).toBe("Invalid credentials (Failure)");
    expect(message).not.toContain("TLS");
  });

  it("leaves a connection timeout untouched", () => {
    const err = Object.assign(new Error("Connection timeout"), {
      code: "ETIMEDOUT",
    });

    expect(describeConnectionError(err)).toBe("Connection timeout");
  });

  it("leaves a DNS failure untouched", () => {
    const err = Object.assign(
      new Error("getaddrinfo ENOTFOUND mail.nonexistent.example"),
      { code: "ENOTFOUND" },
    );

    expect(describeConnectionError(err)).toContain("ENOTFOUND");
    expect(describeConnectionError(err)).not.toContain("Accept mismatched");
  });

  it("handles a non-Error value", () => {
    expect(describeConnectionError("something broke")).toBe("something broke");
    expect(describeConnectionError(undefined)).toBe("undefined");
  });
});
