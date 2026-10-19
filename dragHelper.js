// Drag helper for the Downloads menu (X11 only).
//
// GNOME Shell can only drag things around inside the shell itself, not into
// application windows. When you drag a download out of the menu, the menu
// closes (which releases the shell's pointer grab) and asks this small GTK 3
// program to continue the drag as a normal desktop drag-and-drop, so you can
// drop the file into Files, a browser upload field, a mail or chat window, …
//
// The extension starts it on demand and talks to it over D-Bus
// (org.gtk.Actions on the application id below). It quits after a while idle.

import Gdk from 'gi://Gdk?version=3.0';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import System from 'system';

const APP_ID = 'io.github.matsch82.DownloadsMenu.DragHelper';
const IDLE_QUIT_SECONDS = 10 * 60;
const ICON_SIZE = 64;
const GRAB_RETRY_MS = 30;
const GRAB_RETRY_LIMIT = 30;

const TARGET_URIS = 0;
const TARGET_TEXT = 1;

class DragHelper {
    constructor() {
        this._current = null;
        this._idleId = 0;

        this.app = new Gtk.Application({application_id: APP_ID});
        this.app.connect('startup', () => this._startup());
        this.app.connect('activate', () => {});
    }

    run() {
        return this.app.run([System.programInvocationName, ...System.programArgs]);
    }

    _startup() {
        this.app.hold();

        // GTK needs a realized widget to drag from; nobody ever sees it.
        this._source = new Gtk.Window({type: Gtk.WindowType.POPUP});
        this._source.set_default_size(1, 1);
        this._source.move(-100, -100);
        this._source.show();

        this._source.connect('drag-begin', (w, context) => this._setDragIcon(context));
        this._source.connect('drag-data-get', (w, context, selection, info) => {
            if (!this._current)
                return;
            if (info === TARGET_URIS)
                selection.set_uris(this._current.uris);
            else
                selection.set_text(this._current.paths.join('\n'), -1);
        });
        this._source.connect('drag-end', () => {
            this._current = null;
            this._scheduleQuit();
        });

        const drag = new Gio.SimpleAction({
            name: 'drag',
            parameter_type: new GLib.VariantType('s'),
        });
        drag.connect('activate', (action, parameter) => {
            try {
                this._startDrag(JSON.parse(parameter.unpack()));
            } catch (e) {
                logError(e, 'Downloads drag helper: bad request');
            }
        });
        this.app.add_action(drag);

        const quit = new Gio.SimpleAction({name: 'quit'});
        quit.connect('activate', () => this.app.quit());
        this.app.add_action(quit);

        this._scheduleQuit();
    }

    _scheduleQuit() {
        if (this._idleId)
            GLib.source_remove(this._idleId);
        this._idleId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, IDLE_QUIT_SECONDS, () => {
            this._idleId = 0;
            if (!this._current)
                this.app.quit();
            return GLib.SOURCE_REMOVE;
        });
    }

    _buttonHeld() {
        const surface = this._source.get_window();
        const pointer = Gdk.Display.get_default().get_default_seat().get_pointer();
        const [, , , mask] = surface.get_device_position(pointer);
        return (mask & Gdk.ModifierType.BUTTON1_MASK) !== 0;
    }

    _startDrag({uris, paths, icon}) {
        if (!Array.isArray(uris) || uris.length === 0)
            return;
        this._current = {uris, paths: paths ?? [], icon: icon ?? {}};
        this._scheduleQuit();
        this._tryBegin(0);
    }

    // The shell lets go of the pointer a moment after it asks us to take over,
    // so the first grab can fail. Retry while the mouse button is still down.
    _tryBegin(attempt) {
        if (!this._current)
            return;
        if (!this._buttonHeld()) {
            this._current = null;
            return;
        }

        const targets = Gtk.TargetList.new([]);
        targets.add(Gdk.Atom.intern('text/uri-list', false), 0, TARGET_URIS);
        targets.add_text_targets(TARGET_TEXT);

        const context = this._source.drag_begin_with_coordinates(targets,
            Gdk.DragAction.COPY | Gdk.DragAction.MOVE, 1, null, -1, -1);
        if (context)
            return;

        if (attempt + 1 >= GRAB_RETRY_LIMIT) {
            this._current = null;
            return;
        }
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, GRAB_RETRY_MS, () => {
            this._tryBegin(attempt + 1);
            return GLib.SOURCE_REMOVE;
        });
    }

    _setDragIcon(context) {
        const {path, gicon} = this._current?.icon ?? {};
        try {
            if (path) {
                const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(path, ICON_SIZE, ICON_SIZE, true);
                Gtk.drag_set_icon_pixbuf(context, pixbuf, pixbuf.get_width() / 2, pixbuf.get_height() / 2);
                return;
            }
            if (gicon) {
                Gtk.drag_set_icon_gicon(context, Gio.Icon.new_for_string(gicon), 16, 16);
                return;
            }
        } catch (e) {
            logError(e, 'Downloads drag helper: no drag icon');
        }
        Gtk.drag_set_icon_default(context);
    }
}

new DragHelper().run();
