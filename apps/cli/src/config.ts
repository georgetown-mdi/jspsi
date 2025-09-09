import { z } from 'zod';

interface ArgumentMeta {
  describe?: string;
  alias?: string | readonly string[];
  optionPath?: string;
}

interface OptionalArgumentMeta extends ArgumentMeta {
  type: 'string' | 'number' | 'boolean' | undefined;
}

interface PositionalArgumentMeta extends ArgumentMeta {
  position: number;
  demandOption: boolean;
}

interface CliRegistryMeta extends Pick<ArgumentMeta, 'describe' | 'alias'>{
  position?: number;
  optionName?: string;
}

const cliRegistry = z.registry<CliRegistryMeta>();

const sftpConfigSchema = z.strictObject({
  port: z.optional(z.int().min(0).max(65535)).register(cliRegistry, { describe: 'Port number of the server.' }),
  forceIPv4: z.optional(z.stringbool()).register(cliRegistry, { optionName: 'force-ip-v4', describe: 'Only connect via resolved IPv4 address for `host`.' }),
  forceIPv6: z.optional(z.stringbool()).register(cliRegistry, { optionName: 'force-ip-v6', describe: 'Only connect via resolved IPv6 address for `host`.' }),
  username: z.optional(z.string()).register(cliRegistry, { describe: 'Username for authentication.' }),
  password: z.optional(z.string()).register(cliRegistry, { describe: 'Password for password-based user authentication.' }),
  agent: z.optional(z.string()).register(cliRegistry, { describe: 'Path to ssh-agent\'s UNIX socket for ssh-agent-based user authentication (or \'pageant\' when using Pagent on Windows).' }),
  privateKey: z.optional(z.string()).register(cliRegistry, { describe: 'Buffer or string that contains a private key for either key-based or hostbased user authentication (OpenSSH format).' }),
  passphrase: z.optional(z.string()).register(cliRegistry, { describe: 'For an encrypted private key, this is the passphrase used to decrypt it.' }),
  localHostname: z.optional(z.string()).register(cliRegistry, { describe: 'Along with `localUsername` and `privateKey`, set this to a non-empty string for hostbased user authentication.' }),
  localUsername: z.optional(z.string()).register(cliRegistry, { describe: 'Along with `localHostname` and `privateKey`, set this to a non-empty string for hostbased user authentication.' }),
  keepaliveInterval: z.optional(z.number().nonnegative()).register(cliRegistry, { describe: 'How often (in milliseconds) to send SSH-level keepalive packets to the server. Set to 0 to disable.' }),
  keepaliveCountMax: z.optional(z.number()).register(cliRegistry, { describe: 'How many consecutive, unanswered SSH-level keepalive packets that can be sent to the server before disconnection.' }),
  readyTimeout: z.optional(z.int().nonnegative()).register(cliRegistry, { describe: 'How long (in milliseconds) to wait for the SSH handshake to complete.' }),
  strictVendor: z.optional(z.stringbool()).register(cliRegistry, { describe: 'Performs a strict server vendor check before sending vendor-specific requests.' }),
  agentForward: z.optional(z.stringbool()).register(cliRegistry, { describe: 'Set to `true` to use OpenSSH agent forwarding (`auth-agent@openssh.com`) for the life of the connection.' }),
  localAddress: z.optional(z.union([z.ipv4(), z.ipv6(), z.literal('localhost')])).register(cliRegistry, { describe: 'IP address of the network interface to use to connect to the server. Default: (none -- determined by OS)' }),
  localPort: z.optional(z.int().min(0).max(65535)).register(cliRegistry, { describe: 'The local port number to connect from. Default: (none -- determined by OS)' }),
  timeout: z.optional(z.number().nonnegative()).register(cliRegistry, {  describe: 'The underlying socket timeout in ms. Default: none)' }),
  ident: z.optional(z.string()).register(cliRegistry, { describe: 'A custom server software name/version identifier. Default: \'ssh2js\' + moduleVersion + \'srv\'' }),
  promiseLimit: z.optional(z.int().nonnegative()).register(cliRegistry, { describe: 'Max concurrent promises for downloadDir/uploadDir.' }),
});

export const configSchema = z.strictObject({
  server: z.url({protocol: /^(https?)|(sftp)$/}).register(cliRegistry, {
    position: 0,
    describe: "Server URL",
  }),
  input: z.string().register(cliRegistry, {
    position: 1,
    describe: "Input file path; if `-` will read from stdin",
  }),
  output: z.optional(z.string()).register(cliRegistry, {
    position: 2,
    describe: "Output file path; if empty, writes to stdout",
  }),
  passkey: z.optional(z.string()).register(cliRegistry, {
    describe: "Passkey for authentication",
  }),
  timeout: z.optional(z.number().positive().default(60 * 15)).register(
    cliRegistry, {
      describe: "Seconds to wait for peer before quitting"
    }
  ),
  serverOptions: z.optional(sftpConfigSchema).register(cliRegistry, { optionName: 'server', describe: 'Server Options:' })
});

export type Config = z.infer<typeof configSchema>;

// Infer the TypeScript type from the schema



export interface CliSpec {
  positionals: Array<{ key: string; meta: PositionalArgumentMeta }>;
  options: Array<{ key: string; meta: OptionalArgumentMeta }>;
  groups: Array<[Array<string>, string]>;
}

export function schemaToYargs(schema: z.ZodObject<any>): CliSpec {
  const shape = schema.shape;
  const positionals: CliSpec["positionals"] = [];
  const options: CliSpec["options"] = [];
  const groups: CliSpec['groups'] = [];

  for (const key of Object.keys(shape)) {
    const node = shape[key] as z.ZodObject<any>;
    const nodeInner = node instanceof z.ZodOptional ? (node as z.ZodOptional).def.innerType : node;
    const meta = cliRegistry.get(node);

    const optionName = meta?.optionName || key.replace(/[A-Z]/g, x => `-${x.toLowerCase()}`);

    if (nodeInner instanceof z.ZodObject) {
      const { options: innerOptions } = schemaToYargs(nodeInner);
      const groupId = optionName;
      const groupName = meta?.describe;
      const groupMembers: Array<string> = []

      innerOptions.forEach(({key, meta}) => {
        const optionName = groupId + '-' + key;
        const { optionPath, ...otherProperties } = meta;
        options.push({
          key: optionName,
          meta: {
            ...otherProperties,
            optionPath: key + '.' + optionPath
          }
        });
        groupMembers.push(groupId);
      });

      if (groupName) groups.push([groupMembers, groupName])
    }
    if (!meta) continue;

    const { optionName: _, position, ...otherProperties } = meta;
    if (meta.position !== undefined) {
      positionals.push({
        key: optionName,
        meta: {
          position: meta.position,
          demandOption: !node.safeParse(undefined).success,
          ...otherProperties
        },
      });
    } else {
      const otherProperties = (({ optionName, position, ...otherArguments}) =>  otherArguments)(meta);
      // map Zod type to Yargs type
      let type: OptionalArgumentMeta['type'];

      if (nodeInner instanceof z.ZodString) type = "string";
      if (nodeInner instanceof z.ZodNumber) type = "number";
      if (nodeInner instanceof z.ZodBoolean) type = "boolean";

      options.push({
        key: optionName,
        meta: {
          type,
          ...otherProperties
        }
      });
    }
  }

  // sort positionals by position
  positionals.sort((a, b) => a.meta.position - b.meta.position);

  return { positionals, options, groups };
}