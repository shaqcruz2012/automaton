import { describe, it, expect } from "vitest";
import { buildTransferWithAuthTx } from "../../gateway/on-chain.js";

describe("on-chain execution", () => {
  it("builds correct TransferWithAuthorization calldata", () => {
    const calldata = buildTransferWithAuthTx({
      from: "0x1111111111111111111111111111111111111111",
      to: "0xad045ca2979269Bb7471DC9750BfFeaa24E8A706",
      value: "250000",
      validAfter: "1709300000",
      validBefore: "1709300300",
      nonce: "0x" + "ab".repeat(32),
      signature: "0x" + "cd".repeat(65),
    });

    // Should be non-empty hex data encoding transferWithAuthorization call
    expect(calldata).toMatch(/^0x[a-f0-9]+$/);
    // Function selector for transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)
    // is 0xe3ee160e
    expect(calldata.startsWith("0xe3ee160e")).toBe(true);
  });
});
