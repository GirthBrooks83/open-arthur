// On-device ("local") brain — native builds.
//
// The local model runs on WebGPU in the web app only. Native builds get
// this honest placeholder instead of a dead control; the cloud brain in
// the native app is unaffected.

import { Text, View } from "react-native";
import { detectLocalBrainSupport } from "./brain";
import { Card, s } from "./ui";

export function LocalBrainChat() {
  const support = detectLocalBrainSupport({ isWeb: false, hasWebGPU: false });
  return (
    <View style={{ flex: 1 }}>
      <Card style={{ padding: 16, gap: 8 }}>
        <Text style={s.heading}>On-device brain unavailable</Text>
        <Text style={s.muted}>
          {support.supported ? "" : support.reason} Cloud chat still works — switch back above.
        </Text>
      </Card>
    </View>
  );
}
