// Copyright 2023 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import * as Errors from '../types/errors';
import { getConversation } from '../util/getConversation';
import { DAY } from '../util/durations';
import { drop } from '../util/drop';
import { BackOff, FIBONACCI_TIMEOUTS } from '../util/BackOff';
import { checkForUsername } from '../util/lookupConversationWithoutServiceId';
import { storageJobQueue } from '../util/JobQueue';
import { getProfile } from '../util/getProfile';
import { isSharingPhoneNumberWithEverybody } from '../util/phoneNumberSharingMode';
import * as log from '../logging/log';
import { resolveUsernameByLink } from './username';
import { runStorageServiceSyncJob } from './storage';
import { writeProfile } from './writeProfile';

const CHECK_INTERVAL = DAY;

class UsernameIntegrityService {
  private isStarted = false;
  private readonly backOff = new BackOff(FIBONACCI_TIMEOUTS);

  async start(): Promise<void> {
    if (this.isStarted) {
      return;
    }

    this.isStarted = true;

    this.scheduleCheck();
  }

  private scheduleCheck(): void {
    const lastCheckTimestamp = window.storage.get(
      'usernameLastIntegrityCheck',
      0
    );
    const delay = Math.max(0, lastCheckTimestamp + CHECK_INTERVAL - Date.now());
    if (delay === 0) {
      log.info('usernameIntegrity: running the check immediately');
      drop(this.safeCheck());
    } else {
      log.info(`usernameIntegrity: running the check in ${delay}ms`);
      setTimeout(() => drop(this.safeCheck()), delay);
    }
  }

  private async safeCheck(): Promise<void> {
    try {
      await storageJobQueue(() => this.check());
      this.backOff.reset();
      await window.storage.put('usernameLastIntegrityCheck', Date.now());

      this.scheduleCheck();
    } catch (error) {
      const delay = this.backOff.getAndIncrement();
      log.error(
        'usernameIntegrity: check failed with ' +
          `error: ${Errors.toLogFormat(error)} retrying in ${delay}ms`
      );
      setTimeout(() => drop(this.safeCheck()), delay);
    }
  }

  private async check(): Promise<void> {
    await this.checkUsername();
    await this.checkPhoneNumberSharing();
  }

  private async checkUsername(): Promise<void> {
    const me = window.ConversationController.getOurConversationOrThrow();
    const username = me.get('username');
    const aci = me.getAci();

    let failed = false;

    if (!username) {
      log.info('usernameIntegrity: no username');
      return;
    }
    if (!aci) {
      log.info('usernameIntegrity: no aci');
      return;
    }

    const result = await checkForUsername(username);
    if (result?.aci !== aci) {
      log.error('usernameIntegrity: no remote username');
      await window.storage.put('usernameCorrupted', true);
      failed = true;

      // Intentional fall-through
    }

    const link = window.storage.get('usernameLink');
    if (!link) {
      log.info('usernameIntegrity: no username link');
      return;
    }

    const linkUsername = await resolveUsernameByLink(link);
    if (linkUsername !== username) {
      log.error('usernameIntegrity: invalid username link');
      await window.storage.put('usernameLinkCorrupted', true);
      failed = true;
    }

    if (!failed) {
      log.info('usernameIntegrity: check pass');
    }
  }

  private async checkPhoneNumberSharing(): Promise<void> {
    const me = window.ConversationController.getOurConversationOrThrow();

    await getProfile(me.getServiceId(), me.get('e164'));

    {
      const localValue = isSharingPhoneNumberWithEverybody();
      const remoteValue = !me.get('notSharingPhoneNumber');
      if (localValue === remoteValue) {
        return;
      }

      log.warn(
        'usernameIntegrity: phone number sharing mode conflict, running ' +
          `storage service sync (local: ${localValue}, remote: ${remoteValue})`
      );

      runStorageServiceSyncJob();
    }

    window.Whisper.events.once('storageService:syncComplete', () => {
      const localValue = isSharingPhoneNumberWithEverybody();
      const remoteValue = !me.get('notSharingPhoneNumber');
      if (localValue === remoteValue) {
        log.info(
          'usernameIntegrity: phone number sharing mode conflict resolved by ' +
            'storage service sync'
        );
        return;
      }

      log.warn(
        'usernameIntegrity: phone number sharing mode conflict not resolved, ' +
          'updating profile'
      );

      drop(
        writeProfile(getConversation(me), {
          oldAvatar: undefined,
          newAvatar: undefined,
        })
      );
    });
  }
}

export const usernameIntegrity = new UsernameIntegrityService();
