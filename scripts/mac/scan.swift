// Scanner helper for DocPilot on macOS (the counterpart of the Windows WIA dialog).
// Shows the macOS scanner window (ImageKit, as in the Image Capture app) and saves the scan as PNG.
// Usage: docpilot-scan <output.png> [window title]
// Exit code 0 in any case; DocPilot checks whether the output file exists (missing = nothing scanned).
//
// The ImageKit classes are used through the Objective-C runtime (class names, key-value coding and
// delegate selectors), so the helper builds with every macOS SDK without depending on Swift signatures.
// Built by scripts/mac-helper.js.

import Cocoa
import Quartz
import ImageCaptureCore

final class ScanController: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let output: URL
    var window: NSWindow!
    var scannerView: NSView!
    var done = false

    init(output: URL) {
        self.output = output
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let browserClass = NSClassFromString("IKDeviceBrowserView") as? NSView.Type,
              let scannerClass = NSClassFromString("IKScannerDeviceView") as? NSView.Type else {
            FileHandle.standardError.write("ImageKit is not available\n".data(using: .utf8)!)
            finish()
            return
        }
        let title = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "Scan"
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 660),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = title
        window.delegate = self
        window.isReleasedWhenClosed = false

        // Left: list of scanners. Right: the scanner window with preview, settings and the Scan button.
        let browser = browserClass.init(frame: NSRect(x: 0, y: 0, width: 240, height: 660))
        browser.setValue(true, forKey: "displaysLocalScanners")
        browser.setValue(true, forKey: "displaysNetworkScanners")
        browser.setValue(false, forKey: "displaysLocalCameras")
        browser.setValue(false, forKey: "displaysNetworkCameras")
        browser.setValue(self, forKey: "delegate")

        scannerView = scannerClass.init(frame: NSRect(x: 0, y: 0, width: 760, height: 660))
        scannerView.setValue(0, forKey: "transferMode") // IKScannerDeviceViewTransferModeFileBased
        scannerView.setValue(output.deletingLastPathComponent(), forKey: "downloadsDirectory")
        scannerView.setValue("docpilot-scan-raw", forKey: "documentName")
        scannerView.setValue("public.png", forKey: "documentFormat")
        scannerView.setValue(false, forKey: "displaysDownloadsDirectoryControl")
        scannerView.setValue(false, forKey: "displaysPostProcessApplicationControl")
        scannerView.setValue(self, forKey: "delegate")

        let split = NSSplitView(frame: window.contentView!.bounds)
        split.isVertical = true
        split.dividerStyle = .thin
        split.autoresizingMask = [.width, .height]
        split.addSubview(browser)
        split.addSubview(scannerView)
        window.contentView = split
        split.setPosition(240, ofDividerAt: 0)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // IKDeviceBrowserViewDelegate: a scanner was chosen in the list.
    @objc(deviceBrowserView:selectionDidChange:)
    func deviceBrowserView(_ view: AnyObject?, selectionDidChange device: AnyObject?) {
        scannerView?.setValue(device, forKey: "scannerDevice")
    }

    @objc(deviceBrowserView:didEncounterError:)
    func deviceBrowserView(_ view: AnyObject?, didEncounterError error: AnyObject?) {}

    // IKScannerDeviceViewDelegate: the scan was saved as a file.
    @objc(scannerDeviceView:didScanToURL:error:)
    func scannerDeviceView(_ view: AnyObject?, didScanToURL url: AnyObject?, error: AnyObject?) {
        save(url, error)
    }

    // Older variant of the same message.
    @objc(scannerDeviceView:didScanToURL:fileData:error:)
    func scannerDeviceView(_ view: AnyObject?, didScanToURL url: AnyObject?, fileData: AnyObject?, error: AnyObject?) {
        save(url, error)
    }

    @objc(scannerDeviceView:didEncounterError:)
    func scannerDeviceView(_ view: AnyObject?, didEncounterError error: AnyObject?) {}

    func save(_ url: AnyObject?, _ error: AnyObject?) {
        guard error == nil, let src = url as? URL ?? (url as? NSURL).map({ $0 as URL }) else { return }
        let fm = FileManager.default
        if src.standardizedFileURL.path != output.standardizedFileURL.path {
            try? fm.removeItem(at: output)
            do {
                try fm.moveItem(at: src, to: output)
            } catch {
                return
            }
        }
        finish()
    }

    func finish() {
        if done { return }
        done = true
        NSApp.terminate(nil)
    }

    func windowWillClose(_ notification: Notification) { finish() }
}

guard CommandLine.arguments.count > 1 else {
    FileHandle.standardError.write("Usage: docpilot-scan <output.png> [title]\n".data(using: .utf8)!)
    exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let controller = ScanController(output: URL(fileURLWithPath: CommandLine.arguments[1]))
app.delegate = controller
app.run()
