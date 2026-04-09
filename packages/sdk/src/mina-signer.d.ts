// Ambient module declaration for optional peer dependency mina-signer.
// Prevents DTS build failures when the package is not installed.
declare module 'mina-signer' {
  class Client {
    constructor(options: { network: string });
    derivePublicKey(privateKey: string): string;
  }
  export default Client;
}
