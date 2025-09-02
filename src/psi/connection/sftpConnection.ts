import * as z from 'zod';
import { default as EventEmitter } from 'eventemitter3';
import { v4 as uuidv4 } from 'uuid';

import SFTPClient from 'ssh2-sftp-client';

import { getLoggerForVerbosity } from '../../utils/logger';

/** 1 hour */
const DEFAULT_TIME_TO_LIVE_MS = 1000 * 60 * 60;
const DEFAULT_POLLING_FREQUENCY_MS = 100;
const DEFAULT_VERBOSITY = 1;


interface Events {
  data: (data: unknown) => void,
  error: (err: unknown) => void
};

interface Options {
  timeToLive: Date,
  pollingFrequency: number,
  verbose: number
};

const Message = z.object({
  ts: z.number().nonnegative(),
  seq: z.number().nonnegative(),
  payload: z.json()
});

const getDefaultOptions = (): Options => {
  return {
    timeToLive: new Date(Date.now() + DEFAULT_TIME_TO_LIVE_MS),
    pollingFrequency: DEFAULT_POLLING_FREQUENCY_MS,
    verbose: DEFAULT_VERBOSITY
  }
}

/**
 * Catches and emits SFTP errors, throws errors related to improper usage such
 * as connections not being initialized or the remote path containing files it
 * should not.
 */
export class SFTPConnection 
extends EventEmitter<Events, never>
{
  sftp: SFTPClient;
  id: string;
  role: string;
  options: Options;
  log: ReturnType<typeof getLoggerForVerbosity>;
  seq = 0;
  connected = false;

  path: string | undefined;

  peerId: string | undefined;
  firstToParty: boolean | undefined;
  private poller: NodeJS.Timeout | undefined;

  constructor(options?: Partial<Options>) {
    super();
    this.sftp = new SFTPClient();
    this.id = uuidv4();
    this.role = 'unknown';

    this.options = {...getDefaultOptions(), ...options} as Options;
    this.log = getLoggerForVerbosity('sftp', this.options.verbose);
  }

  async open(
    url: string,
    options?: SFTPClient.ConnectOptions
  ) {
    if (!url.startsWith('sftp://')) url = 'sftp://' + url;

    const parsedUrl = new URL(url);
    this.path = parsedUrl.pathname || '';
    if (this.path.endsWith('/'))
      this.path = this.path.slice(0, -1);

    const urlOptions = {
      host: parsedUrl.hostname,
      username: parsedUrl.username,
      password: parsedUrl.password,
      port: parsedUrl.port ? parseInt(parsedUrl.port) : undefined
    };

    const totalOptions = {
      ...urlOptions,
      ...options
    }

    const value = await this.sftp.connect(totalOptions);
    this.connected = true;
    return value;
  }

  async close() {
    if (!this.connected || !this.path)
      throw new Error('not connected to sftp server');
    const result = await this.sftp.end();
    this.connected = false;
    this.path = undefined;
    return result;
  }

  async synchronize() {
    if (!this.connected || !this.path)
      throw new Error('not connected to sftp server');

    if (this.peerId)
      throw new Error('already synchronized');
  
    this.log.info(`${this.role}: synchronizing at remote path ${this.path}`);

    let files: Array<SFTPClient.FileInfo>
    try {
      files = await this.sftp.list(this.path);
    } catch (err: any) {
      this.emit('error', err.message);
      return;
    }
    const helloFiles = files.filter(
      (file) => file.name.endsWith('.hello')
    );

    if (
      helloFiles.length > 1
      || files.some((file) => file.name.endsWith('.wave'))
    ) {
      throw new Error(
        `path ${this.path} on server had preexisting hello or wave files; must be empty to execute protocol`,
      );
    }

    const helloPath = `${this.path}/${this.id}.hello`;

    if (helloFiles.length === 1) {
      /**
       * A list
       * A hello
       * B list
       * B delete A hello
       * B hello
       * A list
       * A delete B hello
       * 
       * This is B.
       */

      const otherFile = helloFiles[0];
      const otherPath = `${this.path}/${otherFile.name}`

      this.firstToParty = false;
      this.role = 'joiner';
      this.peerId = otherFile.name.slice(0, -6);

      this.log.debug(
        `${this.role} creating response ${this.id}.hello and deleting `
        + `discovered ${otherFile.name}`
      );

      try {
        await this.sftp.delete(otherPath);

        await this.sftp.put(
          Buffer.from(new ArrayBuffer(0)),
          helloPath,
          { writeStreamOptions: { encoding: null} }
        );
      } catch (err: any) {
        this.emit('error', err.message);
        return;
      }
    } else {
      /**
       * Either
       * 
       * A ~ B list
       * A ~ B hello
       * A list
       * A wave
       * 
       * or
       * 
       * A ~ B list
       * A ~ B hello
       * A ~ B list
       * A ~ B wave
       */

      this.log.debug(`${this.role}: creating initial ${this.id}.hello`);
      await this.sftp.put(
        Buffer.from(new ArrayBuffer(0)),
        helloPath,
        { writeStreamOptions: { encoding: null } }
      );
      let wavePath: string | undefined;

      const waitForPeer = async () => {
        while (Date.now() <= this.options.timeToLive.getTime()) {
          const currentFiles = await this.sftp.list(this.path!);

          const otherFiles = currentFiles.filter(
            (file) => file.name !== `${this.id}.hello`
          );
          const theseFiles = currentFiles.filter(
            (file) => file.name === `${this.id}.hello`
          );
          const waveFiles = currentFiles.filter(
            (file) => file.name.endsWith('.wave')
          );

          if (otherFiles.length === 0) {
            const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
            await delay(this.options.pollingFrequency);
            continue;
          }

          if (waveFiles.length > 0) {
            /**
             * A ~ B list
             * A ~ B hello
             * A list
             * A wave
             * B list
             * B delete A hello, B hello, wave
             * 
             * This is B
             */
            if (waveFiles.length > 1) {
              throw new Error(
                'more than one wave file - are there other sessions using this remote path?',
                { cause: 'usage' }
              );
            }
            if (otherFiles.length !== 1) {
              throw new Error(
                'wave file detected but no peer hello - are there other sessions using this remote path?',
                { cause: 'usage' }
              );
            }
            if (theseFiles.length !== 1) {
              throw new Error(
                'wave file detected but no self hello - are there other sessions using this remote path?',
                { cause: 'usage' }
              );
            }

            const waveFile = waveFiles[0];
            const otherFile = otherFiles[0];
            const thisFile = theseFiles[0];

            const waveRegex = new RegExp(
              [
                /^/,
                /([0-9a-f]{8}-?[0-9a-f]{4}-?4[0-9a-f]{3}-?[89ab][0-9a-f]{3}-?[0-9a-f]{12})/,
                /-/,
                /([0-9a-f]{8}-?[0-9a-f]{4}-?4[0-9a-f]{3}-?[89ab][0-9a-f]{3}-?[0-9a-f]{12})/,
                /.wave/,
                /$/
              ].map(r => r.source).join(''),
              'i'
            );
            const waveMatches = waveFile.name.match(waveRegex);
            if (!waveMatches || waveMatches.length !== 3)
              throw new Error('wave file name not in expected format');
            if (!waveMatches.some((x) => x === thisFile.name))
              throw new Error('wave file does not reference this connection');
            if (!waveMatches.some((x) => x === otherFile.name))
              throw new Error('wave file does not reference other connection');

            this.firstToParty = waveMatches[1] === this.id;
            this.role = this.firstToParty ? 'starter' : 'joiner';
            this.peerId = otherFile.name.slice(0, -6);

            this.log.debug(`${this.role}: parsed ${waveFile.name}`);

            await this.sftp.delete(`${this.path}/${waveFile.name}`, true);
            await this.sftp.delete(`${this.path}/${otherFile.name}`, true);
            await this.sftp.delete(helloPath, true);

            return;
          }

          if (otherFiles.length > 1) {
            throw new Error(
              `more than one peer hello file in ${this.path} - are there other sessions using this remote path?`,
              { cause: 'usage' }
            );
          }
          const otherFile = otherFiles[0];
          if (theseFiles.length === 0) {
            /**
             * A list
             * A hello
             * B list
             * B delete A hello
             * B hello
             * A delete B hello
             * 
             * This is A
             */
            const otherPath = `${this.path}/${otherFile.name}`

            this.firstToParty = true;
            this.role = 'starter';
            this.peerId = otherFile.name.slice(0, -6);

            this.log.debug(
              `${this.role} detected ${otherFile.name}; deleting it`
            );

            await this.sftp.delete(otherPath, true);

            return;
          } else {
            if (theseFiles.length > 1) {
              throw new Error(
                `more than one self hello file in ${this.path} - are there other sessions using this remote path?`,
                { cause: 'usage' }
              );
            }

            const thisFile = theseFiles[0];

            this.firstToParty = 
              thisFile.modifyTime < otherFile.modifyTime 
              || (
                thisFile.modifyTime === otherFile.modifyTime
                && thisFile.name < otherFile.name
              );
            this.role = this.firstToParty ? 'starter' : 'joiner';
            this.peerId = otherFile.name.slice(0, -6);

            const waveName = `${this.firstToParty ? this.id : this.peerId}-${this.firstToParty ? this.peerId : this.id}.wave`;
            wavePath = `${this.path}/${waveName}`
            const tempPath = `${this.path}/${this.id}.tmp.wave`

            this.log.debug(
              `${this.role} attempting to create ${waveName}`
            );
            await this.sftp.put(
              Buffer.from(new ArrayBuffer(0)),
              tempPath,
              { writeStreamOptions: { encoding: null } }
            );

            try {
              await this.sftp.rename(
                tempPath,
                wavePath
              );
              /**
               * A ~ B list
               * A ~ B hello
               * A ~ list
               * A ~ wave
               * ...
               * 
               * This is A
               */
            } catch (err: any) {
              /**
               * A ~ B list
               * A ~ B hello
               * A ~ B list
               * A wave
               * B try to wave, fail
               * B delete A hello, B hello, wave
               * 
               * This is B
               */
              await this.sftp.delete(tempPath, true);

              if (!err.message.toLowerCase().includes('rename'))
                throw err;

              this.log.debug(
                `${this.role} wave file creation failed, assuming race condition`
              );

              await this.sftp.delete(wavePath, true);
              await this.sftp.delete(`${this.path}/${otherFile.name}`, true);
              await this.sftp.delete(helloPath, true);
            }
            return;
          }
        }

        throw new Error(`${this.role}: synchronization has timed out`);
      }
      try {
        return await waitForPeer();
      } catch (err: any) {
        if (wavePath)
          await this.sftp.delete(wavePath, true);
        await this.sftp.delete(helloPath, true);
        if (err.cause === 'usage') {
          delete err.cause;
          throw err;
        }

        this.emit('error', err.message);
      }
    }
  }

  async send(data: any) {
    if (!this.connected || !this.path)
      throw new Error('not connected to sftp server');

    const outPath = `${this.path}/${this.id}.json`;
    const tempFile = `temp-${uuidv4()}.json`;
    const tempPath = `${this.path}/${tempFile}`;

    try {
      if (await this.sftp.exists(outPath))
        throw new Error(
          `message from ${this.id} exists on server and has not yet been consumed`,
          { cause: 'usage' }
        )
      const msg = JSON.stringify({
        ts: Date.now(),
        seq: this.seq++,
        payload: data
      });
      this.log.info(`${this.role} writing message ${tempFile}`);
      await this.sftp.put(
        Buffer.from(msg),
        tempPath,
        { writeStreamOptions: { encoding: 'utf-8' } }
      );

      this.log.info(`${this.role} renaming ${tempFile} to ${this.id}.json`);
      await this.sftp.rename(
        tempPath,
        outPath
      );
    } catch (err: any) {
      await this.sftp.delete(tempPath, true);
      if (err.cause === 'usage') {
        delete err.cause;
        throw err;
      }
      this.emit('error', err.message);
    }
  }

  private async poll() {
    if (!this.connected || !this.path)
      throw new Error('not connected to sftp server');

    if (!this.peerId)
      throw new Error('not synchronized');

    const inPath = `${this.path}/${this.peerId}.json`;

    try {
      const messageFile = await this.sftp.exists(inPath);
      if (!messageFile) return;

      this.log.info(`${this.role} getting message from ${this.peerId}.json`);
      this.stop();

      const message = await this.sftp.get(
        inPath,
        undefined,
        { readStreamOptions: { flags: 'r', encoding: 'utf-8', autoClose: true } }
      );

      this.sftp.delete(inPath, true);

      this.start();
      const validatedMessage = Message.parse(JSON.parse(message.toString()));
      this.emit('data', validatedMessage.payload);
    } catch (err: any) {
      this.emit('error', err.message);
    }
  }

  start() {
    this.poller = setInterval(() => this.poll(), this.options.pollingFrequency);
  }

  stop() {
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
  }
}