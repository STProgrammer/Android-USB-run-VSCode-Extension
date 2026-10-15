// Native executable fixtures for the real Extension Development Host smoke test.
// These simulate Android tools; they never communicate with a phone.
using System;
using System.IO;
using System.Reflection;

class FakeAndroidTool
{
    static int Main(string[] args)
    {
        string name = Path.GetFileNameWithoutExtension(Assembly.GetExecutingAssembly().Location);
        string log = Environment.GetEnvironmentVariable("ANDROID_USB_RUNNER_TEST_LOG");
        if (String.IsNullOrEmpty(log)) { Console.Error.WriteLine("Missing fixture log"); return 2; }
        File.AppendAllText(log, name + "|" + String.Join("|", args) + Environment.NewLine);
        if (name == "java") { Console.Error.WriteLine("Fixture JDK 21"); return 0; }
        if (name == "aapt2")
        {
            Console.WriteLine("package: name='com.example.fixture.debug' versionCode='1' versionName='1.0'");
            Console.WriteLine("launchable-activity: name='com.example.fixture.MainActivity' label='Fixture'");
            return 0;
        }
        if (name != "adb") { return 2; }
        if (args.Length == 2 && args[0] == "devices" && args[1] == "-l")
        {
            Console.WriteLine("List of devices attached");
            Console.WriteLine("USB_FIXTURE device model:Fixture_Phone transport_id:1");
            Console.WriteLine("emulator-5554 device model:Should_Not_Use transport_id:2");
            Console.WriteLine("192.168.1.20:5555 device model:Should_Not_Use transport_id:3");
            return 0;
        }
        if (args.Length < 3 || args[0] != "-s" || args[1] != "USB_FIXTURE")
        {
            Console.Error.WriteLine("Every device command must target the fixture USB serial.");
            return 3;
        }
        if (args[2] == "install" || args[2] == "install-multiple")
        {
            if (File.Exists(log + ".fail-install")) { Console.WriteLine("Failure [INSTALL_FAILED_USER_RESTRICTED]"); return 1; }
            Console.WriteLine("Success");
            return 0;
        }
        if (args.Length > 4 && args[2] == "shell" && args[3] == "am")
        {
            Console.WriteLine("Starting: Intent { cmp=com.example.fixture.debug/com.example.fixture.MainActivity }");
            return 0;
        }
        Console.Error.WriteLine("Unexpected fixture command");
        return 4;
    }
}
