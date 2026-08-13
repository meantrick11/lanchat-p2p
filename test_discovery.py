"""节点发现模块的回归测试。"""

import unittest
from unittest.mock import patch

from discovery import Discovery, NetworkInterface, TokenManager, _build_interface


class DiscoverySubnetTests(unittest.TestCase):
    """验证节点发现使用真实子网掩码，而不是固定按 /24 判断。"""

    def test_peer_in_same_16_network_is_considered_local(self):
        discovery = Discovery(
            my_uuid="local",
            my_name="Local",
            my_ip="10.45.41.126",
            ws_port=50002,
            token_manager=TokenManager(),
        )

        interface = NetworkInterface(
            name="WLAN",
            ip="10.45.41.126",
            netmask="255.255.0.0",
            network="10.45.0.0/16",
            broadcast="10.45.255.255",
        )
        with patch("discovery.get_network_interfaces", return_value=[interface]):
            self.assertTrue(discovery._is_same_subnet("10.45.35.86"))

    def test_interface_broadcast_uses_real_netmask(self):
        interface = _build_interface("eth0", "10.45.35.86", "255.255.0.0")

        self.assertEqual("10.45.0.0/16", interface.network)
        self.assertEqual("10.45.255.255", interface.broadcast)


if __name__ == "__main__":
    unittest.main()
