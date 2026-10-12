import type { Translator } from '../../lib/i18n';
import type { DeviceDatabasePort } from '../../lib/library/devices/ui-port';
import { Modal } from '../workspace/ui';
import DevicesView from './DevicesView';

/** The device database, opened from the top bar. The port is owned by the window (see windowDevicePort), so a session survives closing the dialog. */
export function DevicesDialog({ t, port, onClose }: { t: Translator; port: DeviceDatabasePort | null; onClose(): void }) {
  return (
    <Modal title={t('libraryDevices.title')} closeLabel={t('common.close')} close={onClose} wide testId="devices-dialog">
      <DevicesView t={t} port={port} />
    </Modal>
  );
}
