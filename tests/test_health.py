# 健康检查接口测试
# 验证服务骨架可正常启动并响应健康检查请求

from fastapi.testclient import TestClient

from app.main import app

# 创建测试客户端
client = TestClient(app)


def test_health_check_returns_ok():
    """测试健康检查接口返回状态正常。"""
    response = client.get("/api/health")
    # 断言 HTTP 状态码为 200
    assert response.status_code == 200
    data = response.json()
    # 断言服务状态为 ok
    assert data["status"] == "ok"
    # 断言服务名称正确
    assert data["service"] == "PrognosOps"


def test_root_returns_workspace_html():
    """测试根路径直接返回工作台页面。"""
    response = client.get("/")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert "<title>PrognosOps 维策 · 设备运维工作台</title>" in response.text
    assert '<span class="po-brand">PrognosOps</span>' in response.text
