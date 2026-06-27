import { React } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { General } from "@vendetta/ui/components";
import { Forms } from "@vendetta/ui/components";
import plugin, { startLogin, logout } from ".";

const { View, Text, Switch, TouchableOpacity, StyleSheet } = General;
const { FormSection, FormRow, FormDivider } = Forms;

const styles = StyleSheet.create({
    container: {
        flex: 1,
        padding: 16,
    },
    statusText: {
        color: "#b5bac1",
        fontSize: 14,
        marginBottom: 12,
    },
    row: {
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        paddingVertical: 12,
    },
    label: {
        color: "#dbdee1",
        fontSize: 16,
        flex: 1,
    },
    sublabel: {
        color: "#b5bac1",
        fontSize: 13,
        marginTop: 2,
    },
    button: {
        borderRadius: 8,
        paddingVertical: 10,
        paddingHorizontal: 20,
        alignItems: "center",
        marginVertical: 6,
    },
    primaryButton: {
        backgroundColor: "#5865f2",
    },
    dangerButton: {
        backgroundColor: "#ed4245",
    },
    buttonText: {
        color: "#fff",
        fontWeight: "600",
        fontSize: 15,
    },
    instructions: {
        color: "#b5bac1",
        fontSize: 13,
        lineHeight: 20,
        marginBottom: 16,
        padding: 12,
        backgroundColor: "#2b2d31",
        borderRadius: 8,
    },
});

export default function Settings() {
    useProxy(storage);

    // Re-render when login state changes by polling – lightweight since the
    // settings screen is open infrequently.
    const [, forceUpdate] = React.useReducer((x: number) => x + 1, 0);

    const alwaysOn = storage.alwaysOn !== false; // default true

    return (
        <View style={styles.container}>
            <Text style={styles.statusText}>
                {plugin.isLoggedIn ? "✅ Logged in" : "❌ Not logged in"}
                {plugin.hasSession ? " · 📡 VR session active" : ""}
            </Text>

            <Text style={styles.instructions}>
                {"1. Tap Login and approve in your browser.\n" +
                    "2. You'll land on an oculus.com page that errors. That's normal.\n" +
                    "3. Copy the whole URL from the address bar and paste it in the prompt."}
            </Text>

            <TouchableOpacity
                style={[styles.button, styles.primaryButton]}
                onPress={() => { startLogin().then(forceUpdate); }}
            >
                <Text style={styles.buttonText}>
                    {plugin.isLoggedIn ? "Re-login" : "Login"}
                </Text>
            </TouchableOpacity>

            {plugin.isLoggedIn && (
                <TouchableOpacity
                    style={[styles.button, styles.dangerButton]}
                    onPress={() => { logout().then(forceUpdate); }}
                >
                    <Text style={styles.buttonText}>Logout</Text>
                </TouchableOpacity>
            )}

            <FormDivider style={{ marginVertical: 16 }} />

            <FormSection title="Behaviour">
                <FormRow
                    label="Always On"
                    subLabel="Broadcast VR status at all times. When off, only broadcasts while in a voice channel."
                    trailing={
                        <Switch
                            value={alwaysOn}
                            onValueChange={(val: boolean) => {
                                storage.alwaysOn = val;
                            }}
                        />
                    }
                />
            </FormSection>
        </View>
    );
}
