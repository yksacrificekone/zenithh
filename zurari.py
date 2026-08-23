#!/usr/bin/env python3
"""
ZURATI - Modern Communication Platform
=======================================
Owned by kone / zaden

A polished desktop chat application inspired by Discord's usability
with original branding, complete functionality, and local persistence.

DEPENDENCIES:
    pip install PySide6

RUN:
    python zurati.py

All data stored in ~/.zurati/
"""

import sys
import os
import json
import sqlite3
import hashlib
import uuid
import shutil
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Optional, Any, Tuple
from dataclasses import dataclass, asdict, field
from enum import Enum
import pickle
import base64
import re

from PySide6.QtWidgets import *
from PySide6.QtCore import *
from PySide6.QtGui import *
from PySide6.QtMultimedia import *
from PySide6.QtMultimediaWidgets import *

# ============================================================================
# DATA MODELS
# ============================================================================

class UserStatus(Enum):
    ONLINE = "online"
    IDLE = "idle"
    DND = "dnd"
    OFFLINE = "offline"

class ChannelType(Enum):
    TEXT = "text"
    VOICE = "voice"
    DM = "dm"
    GROUP = "group"

@dataclass
class User:
    id: str
    username: str
    display_name: str
    avatar: str  # Base64 or path
    status: UserStatus
    status_text: str
    joined_at: str
    is_premium: bool = False
    badges: List[str] = field(default_factory=list)
    custom_theme: Optional[str] = None

@dataclass
class Message:
    id: str
    channel_id: str
    author_id: str
    content: str
    timestamp: str
    edited_at: Optional[str] = None
    attachments: List[str] = field(default_factory=list)
    reactions: Dict[str, List[str]] = field(default_factory=dict)
    reply_to: Optional[str] = None
    pinned: bool = False

@dataclass
class Channel:
    id: str
    name: str
    type: ChannelType
    server_id: Optional[str]
    topic: str = ""
    position: int = 0
    is_private: bool = False
    members: List[str] = field(default_factory=list)

@dataclass
class Server:
    id: str
    name: str
    icon: str
    owner_id: str
    created_at: str
    channels: List[Channel] = field(default_factory=list)
    members: List[str] = field(default_factory=list)
    roles: Dict[str, List[str]] = field(default_factory=dict)

@dataclass
class DMChannel:
    id: str
    user_ids: List[str]
    created_at: str
    last_message: Optional[str] = None

@dataclass
class Notification:
    id: str
    user_id: str
    message: str
    timestamp: str
    read: bool = False
    type: str = "message"

# ============================================================================
# DATABASE MANAGER
# ============================================================================

class DatabaseManager:
    def __init__(self):
        self.data_dir = Path.home() / ".zurati"
        self.data_dir.mkdir(exist_ok=True)
        self.db_path = self.data_dir / "zurati.db"
        self._init_db()
        self._init_demo_data()

    def _init_db(self):
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()

        # Users table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT UNIQUE,
                display_name TEXT,
                avatar TEXT,
                status TEXT,
                status_text TEXT,
                joined_at TEXT,
                is_premium INTEGER,
                badges TEXT,
                custom_theme TEXT
            )
        """)

        # Servers table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS servers (
                id TEXT PRIMARY KEY,
                name TEXT,
                icon TEXT,
                owner_id TEXT,
                created_at TEXT,
                members TEXT,
                roles TEXT
            )
        """)

        # Channels table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS channels (
                id TEXT PRIMARY KEY,
                name TEXT,
                type TEXT,
                server_id TEXT,
                topic TEXT,
                position INTEGER,
                is_private INTEGER,
                members TEXT
            )
        """)

        # Messages table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                channel_id TEXT,
                author_id TEXT,
                content TEXT,
                timestamp TEXT,
                edited_at TEXT,
                attachments TEXT,
                reactions TEXT,
                reply_to TEXT,
                pinned INTEGER
            )
        """)

        # DM Channels table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS dm_channels (
                id TEXT PRIMARY KEY,
                user_ids TEXT,
                created_at TEXT,
                last_message TEXT
            )
        """)

        # Notifications table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS notifications (
                id TEXT PRIMARY KEY,
                user_id TEXT,
                message TEXT,
                timestamp TEXT,
                read INTEGER,
                type TEXT
            )
        """)

        # Settings table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )
        """)

        conn.commit()
        conn.close()

    def _init_demo_data(self):
        """Initialize with demo data if empty"""
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()

        cursor.execute("SELECT COUNT(*) FROM users")
        if cursor.fetchone()[0] == 0:
            # Create default user
            default_user = User(
                id="user1",
                username="kone",
                display_name="kone",
                avatar=self._generate_avatar("kone"),
                status=UserStatus.ONLINE,
                status_text="Building Zurati",
                joined_at=datetime.now().isoformat(),
                is_premium=True,
                badges=["founder", "premium"]
            )
            self.save_user(default_user)

            # Create demo server
            server = Server(
                id="server1",
                name="Zurati HQ",
                icon="🏠",
                owner_id="user1",
                created_at=datetime.now().isoformat(),
                members=["user1"]
            )
            self.save_server(server)

            # Create channels
            channels = [
                Channel("ch1", "general", ChannelType.TEXT, "server1", "Main chat", 0),
                Channel("ch2", "random", ChannelType.TEXT, "server1", "Random stuff", 1),
                Channel("ch3", "gaming", ChannelType.TEXT, "server1", "Gaming talk", 2),
                Channel("ch4", "voice-general", ChannelType.VOICE, "server1", "Voice chat", 3),
            ]
            for ch in channels:
                self.save_channel(ch)

            # Sample messages
            messages = [
                Message("msg1", "ch1", "user1", "Welcome to Zurati! 🎉", 
                       (datetime.now() - timedelta(hours=2)).isoformat()),
                Message("msg2", "ch1", "user1", "This is a modern chat platform built with ❤️",
                       (datetime.now() - timedelta(hours=1)).isoformat()),
                Message("msg3", "ch2", "user1", "Share your memes here!",
                       datetime.now().isoformat()),
            ]
            for msg in messages:
                self.save_message(msg)

        conn.commit()
        conn.close()

    def _generate_avatar(self, name: str) -> str:
        """Generate a simple avatar from username"""
        colors = ["#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4", "#FFEAA7", "#DDA0DD"]
        color = colors[hash(name) % len(colors)]
        # Return a data URI for the avatar
        return f"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='128' height='128'><rect width='128' height='128' fill='{color}'/><text x='64' y='80' font-size='48' text-anchor='middle' fill='white'>{name[0].upper()}</text></svg>"

    def save_user(self, user: User):
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO users 
            (id, username, display_name, avatar, status, status_text, joined_at, is_premium, badges, custom_theme)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            user.id, user.username, user.display_name, user.avatar,
            user.status.value, user.status_text, user.joined_at,
            1 if user.is_premium else 0,
            json.dumps(user.badges),
            user.custom_theme
        ))
        conn.commit()
        conn.close()

    def get_user(self, user_id: str) -> Optional[User]:
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        conn.close()
        if row:
            return User(
                id=row[0],
                username=row[1],
                display_name=row[2],
                avatar=row[3],
                status=UserStatus(row[4]),
                status_text=row[5],
                joined_at=row[6],
                is_premium=bool(row[7]),
                badges=json.loads(row[8]) if row[8] else [],
                custom_theme=row[9]
            )
        return None

    def get_all_users(self) -> List[User]:
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users")
        rows = cursor.fetchall()
        conn.close()
        users = []
        for row in rows:
            users.append(User(
                id=row[0],
                username=row[1],
                display_name=row[2],
                avatar=row[3],
                status=UserStatus(row[4]),
                status_text=row[5],
                joined_at=row[6],
                is_premium=bool(row[7]),
                badges=json.loads(row[8]) if row[8] else [],
                custom_theme=row[9]
            ))
        return users

    def save_server(self, server: Server):
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO servers 
            (id, name, icon, owner_id, created_at, members, roles)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (
            server.id, server.name, server.icon, server.owner_id,
            server.created_at, json.dumps(server.members),
            json.dumps(server.roles)
        ))
        conn.commit()
        conn.close()

    def get_server(self, server_id: str) -> Optional[Server]:
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM servers WHERE id = ?", (server_id,))
        row = cursor.fetchone()
        conn.close()
        if row:
            return Server(
                id=row[0],
                name=row[1],
                icon=row[2],
                owner_id=row[3],
                created_at=row[4],
                members=json.loads(row[5]) if row[5] else [],
                roles=json.loads(row[6]) if row[6] else {}
            )
        return None

    def get_all_servers(self) -> List[Server]:
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM servers")
        rows = cursor.fetchall()
        conn.close()
        servers = []
        for row in rows:
            servers.append(Server(
                id=row[0],
                name=row[1],
                icon=row[2],
                owner_id=row[3],
                created_at=row[4],
                members=json.loads(row[5]) if row[5] else [],
                roles=json.loads(row[6]) if row[6] else {}
            ))
        return servers

    def save_channel(self, channel: Channel):
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO channels 
            (id, name, type, server_id, topic, position, is_private, members)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            channel.id, channel.name, channel.type.value,
            channel.server_id, channel.topic, channel.position,
            1 if channel.is_private else 0,
            json.dumps(channel.members)
        ))
        conn.commit()
        conn.close()

    def get_channels(self, server_id: str) -> List[Channel]:
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM channels WHERE server_id = ? ORDER BY position", (server_id,))
        rows = cursor.fetchall()
        conn.close()
        channels = []
        for row in rows:
            channels.append(Channel(
                id=row[0],
                name=row[1],
                type=ChannelType(row[2]),
                server_id=row[3],
                topic=row[4],
                position=row[5],
                is_private=bool(row[6]),
                members=json.loads(row[7]) if row[7] else []
            ))
        return channels

    def save_message(self, message: Message):
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO messages 
            (id, channel_id, author_id, content, timestamp, edited_at, attachments, reactions, reply_to, pinned)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            message.id, message.channel_id, message.author_id, message.content,
            message.timestamp, message.edited_at, json.dumps(message.attachments),
            json.dumps(message.reactions), message.reply_to,
            1 if message.pinned else 0
        ))
        conn.commit()
        conn.close()

    def get_messages(self, channel_id: str, limit: int = 100) -> List[Message]:
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute("""
            SELECT * FROM messages WHERE channel_id = ? 
            ORDER BY timestamp DESC LIMIT ?
        """, (channel_id, limit))
        rows = cursor.fetchall()
        conn.close()
        messages = []
        for row in rows:
            messages.append(Message(
                id=row[0],
                channel_id=row[1],
                author_id=row[2],
                content=row[3],
                timestamp=row[4],
                edited_at=row[5],
                attachments=json.loads(row[6]) if row[6] else [],
                reactions=json.loads(row[7]) if row[7] else {},
                reply_to=row[8],
                pinned=bool(row[9])
            ))
        return list(reversed(messages))

    def save_dm_channel(self, dm: DMChannel):
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO dm_channels 
            (id, user_ids, created_at, last_message)
            VALUES (?, ?, ?, ?)
        """, (dm.id, json.dumps(dm.user_ids), dm.created_at, dm.last_message))
        conn.commit()
        conn.close()

    def get_dm_channels(self, user_id: str) -> List[DMChannel]:
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM dm_channels")
        rows = cursor.fetchall()
        conn.close()
        dms = []
        for row in rows:
            user_ids = json.loads(row[1])
            if user_id in user_ids:
                dms.append(DMChannel(
                    id=row[0],
                    user_ids=user_ids,
                    created_at=row[2],
                    last_message=row[3]
                ))
        return dms

    def save_notification(self, notif: Notification):
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute("""
            INSERT OR REPLACE INTO notifications 
            (id, user_id, message, timestamp, read, type)
            VALUES (?, ?, ?, ?, ?, ?)
        """, (notif.id, notif.user_id, notif.message, notif.timestamp, 
              1 if notif.read else 0, notif.type))
        conn.commit()
        conn.close()

    def get_notifications(self, user_id: str, limit: int = 50) -> List[Notification]:
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute("""
            SELECT * FROM notifications WHERE user_id = ?
            ORDER BY timestamp DESC LIMIT ?
        """, (user_id, limit))
        rows = cursor.fetchall()
        conn.close()
        return [Notification(
            id=row[0],
            user_id=row[1],
            message=row[2],
            timestamp=row[3],
            read=bool(row[4]),
            type=row[5]
        ) for row in rows]

    def get_setting(self, key: str, default: str = "") -> str:
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute("SELECT value FROM settings WHERE key = ?", (key,))
        row = cursor.fetchone()
        conn.close()
        return row[0] if row else default

    def set_setting(self, key: str, value: str):
        conn = sqlite3.connect(str(self.db_path))
        cursor = conn.cursor()
        cursor.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value))
        conn.commit()
        conn.close()

# ============================================================================
# THEME MANAGER
# ============================================================================

class ThemeManager:
    THEMES = {
        "dark": {
            "bg_primary": "#1a1a2e",
            "bg_secondary": "#16213e",
            "bg_tertiary": "#0f0f1f",
            "bg_hover": "#2a2a4a",
            "bg_input": "#252545",
            "text_primary": "#ffffff",
            "text_secondary": "#a6a6b8",
            "text_muted": "#6a6a7e",
            "border": "#2a2a4a",
            "accent": "#6c5ce7",
            "accent_hover": "#7c6ce7",
            "success": "#00b894",
            "danger": "#ff6b6b",
            "warning": "#fdcb6e",
            "shadow": "rgba(0,0,0,0.3)"
        },
        "light": {
            "bg_primary": "#f5f5f5",
            "bg_secondary": "#ffffff",
            "bg_tertiary": "#e8e8e8",
            "bg_hover": "#e0e0e0",
            "bg_input": "#ffffff",
            "text_primary": "#2d2d2d",
            "text_secondary": "#6a6a6a",
            "text_muted": "#999999",
            "border": "#d0d0d0",
            "accent": "#6c5ce7",
            "accent_hover": "#7c6ce7",
            "success": "#00b894",
            "danger": "#ff6b6b",
            "warning": "#fdcb6e",
            "shadow": "rgba(0,0,0,0.1)"
        },
        "amoled": {
            "bg_primary": "#000000",
            "bg_secondary": "#0a0a0a",
            "bg_tertiary": "#1a1a1a",
            "bg_hover": "#202020",
            "bg_input": "#151515",
            "text_primary": "#ffffff",
            "text_secondary": "#a0a0a0",
            "text_muted": "#606060",
            "border": "#202020",
            "accent": "#6c5ce7",
            "accent_hover": "#7c6ce7",
            "success": "#00b894",
            "danger": "#ff6b6b",
            "warning": "#fdcb6e",
            "shadow": "rgba(0,0,0,0.5)"
        }
    }

    def __init__(self):
        self.current_theme = "dark"
        self.accent_color = "#6c5ce7"

    def get_style(self, theme_name: str = None) -> str:
        theme = self.THEMES.get(theme_name or self.current_theme, self.THEMES["dark"])
        accent = self.accent_color
        
        return f"""
            QMainWindow, QWidget {{
                background: {theme['bg_primary']};
                color: {theme['text_primary']};
                font-family: 'Segoe UI', -apple-system, sans-serif;
            }}
            
            QPushButton {{
                background: {theme['bg_secondary']};
                color: {theme['text_primary']};
                border: 1px solid {theme['border']};
                border-radius: 8px;
                padding: 8px 16px;
                font-weight: 500;
            }}
            
            QPushButton:hover {{
                background: {theme['bg_hover']};
            }}
            
            QPushButton#accent {{
                background: {accent};
                border: none;
                color: white;
            }}
            
            QPushButton#accent:hover {{
                background: {theme['accent_hover']};
            }}
            
            QLineEdit, QTextEdit, QPlainTextEdit {{
                background: {theme['bg_input']};
                color: {theme['text_primary']};
                border: 1px solid {theme['border']};
                border-radius: 8px;
                padding: 8px 12px;
            }}
            
            QListWidget, QListWidget::item {{
                background: {theme['bg_secondary']};
                color: {theme['text_secondary']};
                border: none;
                padding: 4px;
            }}
            
            QListWidget::item:hover {{
                background: {theme['bg_hover']};
                color: {theme['text_primary']};
            }}
            
            QListWidget::item:selected {{
                background: {theme['bg_hover']};
                color: {theme['text_primary']};
            }}
            
            QScrollBar:vertical {{
                background: {theme['bg_primary']};
                width: 8px;
                border-radius: 4px;
            }}
            
            QScrollBar::handle:vertical {{
                background: {theme['bg_hover']};
                border-radius: 4px;
                min-height: 30px;
            }}
            
            QScrollBar::handle:vertical:hover {{
                background: {theme['text_muted']};
            }}
            
            QScrollBar:horizontal {{
                background: {theme['bg_primary']};
                height: 8px;
                border-radius: 4px;
            }}
            
            QScrollBar::handle:horizontal {{
                background: {theme['bg_hover']};
                border-radius: 4px;
                min-width: 30px;
            }}
            
            QMenuBar {{
                background: {theme['bg_primary']};
                color: {theme['text_secondary']};
                border: none;
            }}
            
            QMenuBar::item:selected {{
                background: {theme['bg_hover']};
                color: {theme['text_primary']};
            }}
            
            QMenu {{
                background: {theme['bg_secondary']};
                color: {theme['text_primary']};
                border: 1px solid {theme['border']};
                border-radius: 8px;
            }}
            
            QMenu::item:selected {{
                background: {theme['bg_hover']};
            }}
            
            QTabWidget::pane {{
                background: {theme['bg_secondary']};
                border: 1px solid {theme['border']};
                border-radius: 8px;
            }}
            
            QTabBar::tab {{
                background: {theme['bg_primary']};
                color: {theme['text_secondary']};
                padding: 8px 16px;
                border: 1px solid {theme['border']};
                border-bottom: none;
                border-top-left-radius: 8px;
                border-top-right-radius: 8px;
            }}
            
            QTabBar::tab:selected {{
                background: {theme['bg_secondary']};
                color: {theme['text_primary']};
            }}
            
            QTabBar::tab:hover {{
                background: {theme['bg_hover']};
            }}
            
            QGroupBox {{
                border: 1px solid {theme['border']};
                border-radius: 8px;
                margin-top: 12px;
                padding-top: 12px;
            }}
            
            QGroupBox::title {{
                color: {theme['text_secondary']};
                subcontrol-origin: margin;
                left: 12px;
                padding: 0 8px;
            }}
            
            QCheckBox {{
                color: {theme['text_secondary']};
            }}
            
            QCheckBox::indicator {{
                width: 18px;
                height: 18px;
                border: 2px solid {theme['border']};
                border-radius: 4px;
            }}
            
            QCheckBox::indicator:checked {{
                background: {accent};
                border-color: {accent};
            }}
            
            QRadioButton {{
                color: {theme['text_secondary']};
            }}
            
            QRadioButton::indicator {{
                width: 18px;
                height: 18px;
                border: 2px solid {theme['border']};
                border-radius: 9px;
            }}
            
            QRadioButton::indicator:checked {{
                background: {accent};
                border-color: {accent};
            }}
            
            QComboBox {{
                background: {theme['bg_input']};
                color: {theme['text_primary']};
                border: 1px solid {theme['border']};
                border-radius: 8px;
                padding: 6px 12px;
            }}
            
            QComboBox::drop-down {{
                border: none;
            }}
            
            QComboBox QAbstractItemView {{
                background: {theme['bg_secondary']};
                color: {theme['text_primary']};
                border: 1px solid {theme['border']};
                border-radius: 8px;
            }}
            
            QSpinBox, QDoubleSpinBox {{
                background: {theme['bg_input']};
                color: {theme['text_primary']};
                border: 1px solid {theme['border']};
                border-radius: 8px;
                padding: 4px 8px;
            }}
            
            QSlider::groove:horizontal {{
                height: 4px;
                background: {theme['bg_hover']};
                border-radius: 2px;
            }}
            
            QSlider::handle:horizontal {{
                background: {accent};
                width: 16px;
                height: 16px;
                margin: -6px 0;
                border-radius: 8px;
            }}
            
            QSlider::sub-page:horizontal {{
                background: {accent};
                border-radius: 2px;
            }}
            
            QProgressBar {{
                background: {theme['bg_hover']};
                border-radius: 4px;
                height: 6px;
                text-align: center;
            }}
            
            QProgressBar::chunk {{
                background: {accent};
                border-radius: 4px;
            }}
            
            QToolTip {{
                background: {theme['bg_secondary']};
                color: {theme['text_primary']};
                border: 1px solid {theme['border']};
                border-radius: 4px;
                padding: 4px 8px;
            }}
        """

# ============================================================================
# CUSTOM WIDGETS
# ============================================================================

class AvatarLabel(QLabel):
    def __init__(self, avatar_data: str = "", size: int = 40):
        super().__init__()
        self.setFixedSize(size, size)
        self.setScaledContents(True)
        self.setStyleSheet(f"""
            border-radius: {size//2}px;
            border: 2px solid transparent;
        """)
        if avatar_data:
            self.set_avatar(avatar_data)

    def set_avatar(self, avatar_data: str):
        if avatar_data.startswith("data:image"):
            # Handle data URI
            import base64
            import re
            pattern = r"data:image/([^;]+);base64,(.*)"
            match = re.match(pattern, avatar_data)
            if match:
                img_format, data = match.groups()
                pixmap = QPixmap()
                pixmap.loadFromData(base64.b64decode(data), img_format.upper())
                self.setPixmap(pixmap.scaled(self.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation))
        else:
            # Try loading from file
            pixmap = QPixmap(avatar_data)
            if not pixmap.isNull():
                self.setPixmap(pixmap.scaled(self.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation))

class StatusIndicator(QWidget):
    def __init__(self, status: UserStatus = UserStatus.ONLINE, size: int = 12):
        super().__init__()
        self.setFixedSize(size, size)
        self.status = status
        self.update_style()

    def update_style(self):
        colors = {
            UserStatus.ONLINE: "#00b894",
            UserStatus.IDLE: "#fdcb6e",
            UserStatus.DND: "#ff6b6b",
            UserStatus.OFFLINE: "#6a6a7e"
        }
        self.setStyleSheet(f"""
            background: {colors[self.status]};
            border: 2px solid #1a1a2e;
            border-radius: {self.width()//2}px;
        """)

    def set_status(self, status: UserStatus):
        self.status = status
        self.update_style()

class AnimatedButton(QPushButton):
    def __init__(self, text: str = "", icon: str = ""):
        super().__init__(text)
        self._opacity = 1.0
        self._animation = QPropertyAnimation(self, b"opacity")
        self._animation.setDuration(200)
        
        if icon:
            self.setText(f"{icon} {text}")

    def enterEvent(self, event):
        self._animation.stop()
        self._animation.setStartValue(1.0)
        self._animation.setEndValue(0.8)
        self._animation.start()
        super().enterEvent(event)

    def leaveEvent(self, event):
        self._animation.stop()
        self._animation.setStartValue(0.8)
        self._animation.setEndValue(1.0)
        self._animation.start()
        super().leaveEvent(event)

class ToastNotification(QWidget):
    def __init__(self, message: str, parent=None, duration: int = 3000):
        super().__init__(parent)
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.Tool | Qt.WindowStaysOnTopHint)
        self.setAttribute(Qt.WA_TranslucentBackground)
        
        layout = QHBoxLayout(self)
        layout.setContentsMargins(16, 12, 16, 12)
        
        label = QLabel(message)
        label.setStyleSheet("""
            color: white;
            font-size: 13px;
            font-weight: 500;
        """)
        layout.addWidget(label)
        
        close_btn = QPushButton("✕")
        close_btn.setFixedSize(24, 24)
        close_btn.setStyleSheet("""
            QPushButton {
                background: transparent;
                color: rgba(255,255,255,0.6);
                border: none;
                border-radius: 12px;
                font-size: 12px;
            }
            QPushButton:hover {
                background: rgba(255,255,255,0.1);
                color: white;
            }
        """)
        close_btn.clicked.connect(self.hide)
        layout.addWidget(close_btn)
        
        self.setStyleSheet("""
            background: rgba(30,30,46,0.95);
            border: 1px solid rgba(108,92,231,0.3);
            border-radius: 12px;
        """)
        
        self.resize(400, 60)
        self.show()
        self.move(parent.width() - 420, parent.height() - 80)
        
        QTimer.singleShot(duration, self.fade_out)

    def fade_out(self):
        self.animation = QPropertyAnimation(self, b"windowOpacity")
        self.animation.setDuration(500)
        self.animation.setStartValue(1.0)
        self.animation.setEndValue(0.0)
        self.animation.finished.connect(self.hide)
        self.animation.start()

# ============================================================================
# MAIN APPLICATION
# ============================================================================

class ZuratiApp(QMainWindow):
    def __init__(self):
        super().__init__()
        self.db = DatabaseManager()
        self.theme_manager = ThemeManager()
        self.current_user = self.db.get_user("user1")
        self.current_server = None
        self.current_channel = None
        
        if not self.current_user:
            self.current_user = User(
                id="user1",
                username="kone",
                display_name="kone",
                avatar="",
                status=UserStatus.ONLINE,
                status_text="",
                joined_at=datetime.now().isoformat(),
                is_premium=True
            )
            self.db.save_user(self.current_user)
        
        self.setWindowTitle("Zurati")
        self.setMinimumSize(1200, 800)
        self.setWindowIcon(self.create_window_icon())
        
        self.init_ui()
        self.apply_theme()
        
        # Load initial data
        self.load_servers()
        self.load_dm_channels()
        self.load_notifications()

    def create_window_icon(self) -> QIcon:
        pixmap = QPixmap(64, 64)
        pixmap.fill(QColor("#6c5ce7"))
        painter = QPainter(pixmap)
        painter.setPen(QColor("white"))
        painter.setFont(QFont("Segoe UI", 28, QFont.Bold))
        painter.drawText(pixmap.rect(), Qt.AlignCenter, "Z")
        painter.end()
        return QIcon(pixmap)

    def init_ui(self):
        # Main layout
        central = QWidget()
        self.setCentralWidget(central)
        main_layout = QHBoxLayout(central)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(0)

        # ============================================================
        # LEFT SIDEBAR - Server/DM navigation
        # ============================================================
        self.sidebar = QWidget()
        self.sidebar.setFixedWidth(80)
        self.sidebar.setStyleSheet("""
            QWidget {
                background: #15151e;
                border: none;
            }
        """)
        sidebar_layout = QVBoxLayout(self.sidebar)
        sidebar_layout.setContentsMargins(8, 8, 8, 8)
        sidebar_layout.setSpacing(8)
        sidebar_layout.setAlignment(Qt.AlignTop)

        # Logo
        logo = QLabel("⚡")
        logo.setFixedSize(60, 60)
        logo.setStyleSheet("""
            font-size: 32px;
            background: #6c5ce7;
            border-radius: 16px;
            color: white;
            qproperty-alignment: AlignCenter;
        """)
        sidebar_layout.addWidget(logo)

        # Server list container
        self.server_list_container = QWidget()
        server_list_layout = QVBoxLayout(self.server_list_container)
        server_list_layout.setContentsMargins(0, 0, 0, 0)
        server_list_layout.setSpacing(4)
        server_list_layout.setAlignment(Qt.AlignTop)

        # Servers will be added here dynamically
        self.server_buttons = {}
        self.dm_buttons = {}

        sidebar_layout.addWidget(self.server_list_container)
        sidebar_layout.addStretch()

        # Bottom actions
        bottom_btns = [
            ("🔍", "Search"),
            ("📩", "DM"),
            ("⚙️", "Settings"),
        ]
        for icon, tooltip in bottom_btns:
            btn = QPushButton(icon)
            btn.setFixedSize(60, 60)
            btn.setToolTip(tooltip)
            btn.setStyleSheet("""
                QPushButton {
                    background: transparent;
                    color: #a6a6b8;
                    font-size: 20px;
                    border-radius: 16px;
                    border: none;
                }
                QPushButton:hover {
                    background: #2a2a4a;
                    color: white;
                }
            """)
            if tooltip == "Settings":
                btn.clicked.connect(self.open_settings)
            sidebar_layout.addWidget(btn)

        main_layout.addWidget(self.sidebar)

        # ============================================================
        # CHANNEL LIST
        # ============================================================
        self.channel_panel = QWidget()
        self.channel_panel.setFixedWidth(240)
        self.channel_panel.setStyleSheet("""
            QWidget {
                background: #1a1a2e;
            }
        """)
        channel_panel_layout = QVBoxLayout(self.channel_panel)
        channel_panel_layout.setContentsMargins(0, 0, 0, 0)
        channel_panel_layout.setSpacing(0)

        # Server header
        self.server_header = QWidget()
        self.server_header.setFixedHeight(60)
        self.server_header.setStyleSheet("""
            QWidget {
                background: #1e1e32;
                border-bottom: 1px solid #2a2a4a;
            }
        """)
        header_layout = QHBoxLayout(self.server_header)
        header_layout.setContentsMargins(16, 0, 16, 0)
        
        self.server_name_label = QLabel("Select a server")
        self.server_name_label.setStyleSheet("""
            color: white;
            font-size: 16px;
            font-weight: bold;
        """)
        header_layout.addWidget(self.server_name_label)
        
        header_btn = QPushButton("▼")
        header_btn.setFixedSize(32, 32)
        header_btn.setStyleSheet("""
            QPushButton {
                background: transparent;
                color: #a6a6b8;
                border: none;
                font-size: 14px;
                border-radius: 8px;
            }
            QPushButton:hover {
                background: #2a2a4a;
            }
        """)
        header_layout.addWidget(header_btn)
        
        channel_panel_layout.addWidget(self.server_header)

        # Channel list
        self.channel_list = QListWidget()
        self.channel_list.setStyleSheet("""
            QListWidget {
                background: #1a1a2e;
                border: none;
                padding: 8px;
            }
            QListWidget::item {
                padding: 8px 12px;
                color: #a6a6b8;
                border-radius: 6px;
            }
            QListWidget::item:hover {
                background: #2a2a4a;
                color: white;
            }
            QListWidget::item:selected {
                background: #2d2d44;
                color: white;
            }
        """)
        self.channel_list.itemClicked.connect(self.on_channel_selected)
        channel_panel_layout.addWidget(self.channel_list)

        # Add channel button
        add_channel_btn = QPushButton("+ Add Channel")
        add_channel_btn.setStyleSheet("""
            QPushButton {
                background: #2a2a4a;
                color: #a6a6b8;
                border: none;
                border-radius: 8px;
                padding: 12px;
                margin: 8px;
                text-align: left;
            }
            QPushButton:hover {
                background: #3a3a5a;
                color: white;
            }
        """)
        add_channel_btn.clicked.connect(self.show_create_channel_dialog)
        channel_panel_layout.addWidget(add_channel_btn)

        main_layout.addWidget(self.channel_panel)

        # ============================================================
        # CHAT AREA
        # ============================================================
        self.chat_container = QWidget()
        chat_container_layout = QVBoxLayout(self.chat_container)
        chat_container_layout.setContentsMargins(0, 0, 0, 0)
        chat_container_layout.setSpacing(0)

        # Chat header
        self.chat_header = QWidget()
        self.chat_header.setFixedHeight(60)
        self.chat_header.setStyleSheet("""
            QWidget {
                background: #1a1a2e;
                border-bottom: 1px solid #2a2a4a;
            }
        """)
        chat_header_layout = QHBoxLayout(self.chat_header)
        chat_header_layout.setContentsMargins(20, 0, 20, 0)
        
        self.channel_title = QLabel("# Select a channel")
        self.channel_title.setStyleSheet("""
            color: white;
            font-size: 18px;
            font-weight: bold;
        """)
        chat_header_layout.addWidget(self.channel_title)
        
        chat_header_layout.addStretch()
        
        # Header actions
        for icon, tooltip in [("🔍", "Search"), ("📌", "Pins"), ("👤", "Members")]:
            btn = QPushButton(icon)
            btn.setFixedSize(36, 36)
            btn.setToolTip(tooltip)
            btn.setStyleSheet("""
                QPushButton {
                    background: transparent;
                    color: #a6a6b8;
                    font-size: 16px;
                    border-radius: 8px;
                    border: none;
                }
                QPushButton:hover {
                    background: #2a2a4a;
                    color: white;
                }
            """)
            chat_header_layout.addWidget(btn)
        
        chat_container_layout.addWidget(self.chat_header)

        # Messages
        self.message_display = QTextEdit()
        self.message_display.setReadOnly(True)
        self.message_display.setStyleSheet("""
            QTextEdit {
                background: #1a1a2e;
                border: none;
                padding: 16px;
                color: #e0e0e0;
                font-size: 14px;
                line-height: 1.6;
            }
            QTextEdit::viewport {
                background: #1a1a2e;
            }
        """)
        chat_container_layout.addWidget(self.message_display)

        # Message input
        self.input_container = QWidget()
        self.input_container.setStyleSheet("""
            QWidget {
                background: #1a1a2e;
                border-top: 1px solid #2a2a4a;
            }
        """)
        self.input_container.setFixedHeight(80)
        input_layout = QHBoxLayout(self.input_container)
        input_layout.setContentsMargins(20, 10, 20, 10)
        input_layout.setSpacing(12)

        self.message_input = QTextEdit()
        self.message_input.setPlaceholderText("Message...")
        self.message_input.setStyleSheet("""
            QTextEdit {
                background: #2a2a4a;
                border: none;
                border-radius: 8px;
                padding: 12px;
                color: white;
                font-size: 14px;
            }
            QTextEdit::viewport {
                background: #2a2a4a;
            }
        """)
        self.message_input.setMaximumHeight(60)
        self.message_input.installEventFilter(self)
        input_layout.addWidget(self.message_input)

        self.send_btn = QPushButton("➤")
        self.send_btn.setFixedSize(50, 50)
        self.send_btn.setObjectName("accent")
        self.send_btn.setStyleSheet("""
            QPushButton#accent {
                background: #6c5ce7;
                color: white;
                border-radius: 25px;
                font-size: 20px;
                border: none;
            }
            QPushButton#accent:hover {
                background: #7c6ce7;
            }
        """)
        self.send_btn.clicked.connect(self.send_message)
        input_layout.addWidget(self.send_btn)

        chat_container_layout.addWidget(self.input_container)

        # ============================================================
        # MEMBER LIST
        # ============================================================
        self.member_panel = QWidget()
        self.member_panel.setFixedWidth(240)
        self.member_panel.setStyleSheet("""
            QWidget {
                background: #1a1a2e;
            }
        """)
        member_layout = QVBoxLayout(self.member_panel)
        member_layout.setContentsMargins(0, 0, 0, 0)
        member_layout.setSpacing(0)

        member_header = QWidget()
        member_header.setFixedHeight(60)
        member_header.setStyleSheet("background: #1e1e32; border-bottom: 1px solid #2a2a4a;")
        member_header_layout = QHBoxLayout(member_header)
        member_header_layout.setContentsMargins(16, 0, 16, 0)
        
        member_label = QLabel("Members")
        member_label.setStyleSheet("color: #a6a6b8; font-size: 13px; font-weight: bold;")
        member_header_layout.addWidget(member_label)
        member_header_layout.addStretch()
        
        member_layout.addWidget(member_header)

        self.member_list = QListWidget()
        self.member_list.setStyleSheet("""
            QListWidget {
                background: #1a1a2e;
                border: none;
                padding: 8px;
            }
            QListWidget::item {
                padding: 8px 12px;
                color: #a6a6b8;
                border-radius: 6px;
            }
            QListWidget::item:hover {
                background: #2a2a4a;
            }
        """)
        member_layout.addWidget(self.member_list)

        main_layout.addWidget(self.member_panel)

        # ============================================================
        # Enable drag and drop for the sidebar
        # ============================================================
        self.sidebar.setAcceptDrops(True)
        self.sidebar.dragEnterEvent = self.drag_enter_event
        self.sidebar.dropEvent = self.drop_event

    def drag_enter_event(self, event):
        if event.mimeData().hasText():
            event.acceptProposedAction()

    def drop_event(self, event):
        # Handle server reordering
        pass

    def eventFilter(self, obj, event):
        if obj == self.message_input and event.type() == QEvent.KeyPress:
            if event.key() == Qt.Key_Return and not event.modifiers() & Qt.ShiftModifier:
                self.send_message()
                return True
        return super().eventFilter(obj, event)

    # ============================================================
    # CORE FUNCTIONALITY
    # ============================================================

    def apply_theme(self):
        self.setStyleSheet(self.theme_manager.get_style())

    def load_servers(self):
        # Clear existing server buttons
        for btn in self.server_buttons.values():
            btn.deleteLater()
        self.server_buttons.clear()

        # Load from database
        servers = self.db.get_all_servers()
        
        # Add server buttons
        for server in servers:
            btn = QPushButton(server.icon or "🏠")
            btn.setFixedSize(60, 60)
            btn.setToolTip(server.name)
            btn.setStyleSheet("""
                QPushButton {
                    background: transparent;
                    color: #a6a6b8;
                    font-size: 24px;
                    border-radius: 16px;
                    border: none;
                }
                QPushButton:hover {
                    background: #2a2a4a;
                    border-radius: 12px;
                }
                QPushButton:checked {
                    background: #2d2d44;
                    border-radius: 12px;
                }
            """)
            btn.setCheckable(True)
            btn.clicked.connect(lambda checked, s=server: self.select_server(s))
            self.server_buttons[server.id] = btn
            self.server_list_container.layout().addWidget(btn)

        # Add DM button
        dm_btn = QPushButton("💬")
        dm_btn.setFixedSize(60, 60)
        dm_btn.setToolTip("Direct Messages")
        dm_btn.setStyleSheet("""
            QPushButton {
                background: transparent;
                color: #a6a6b8;
                font-size: 24px;
                border-radius: 16px;
                border: none;
            }
            QPushButton:hover {
                background: #2a2a4a;
                border-radius: 12px;
            }
        """)
        dm_btn.clicked.connect(self.show_dm_list)
        self.server_list_container.layout().addWidget(dm_btn)

    def load_dm_channels(self):
        if not self.current_user:
            return
        dms = self.db.get_dm_channels(self.current_user.id)
        # Update member list or DM view
        pass

    def load_notifications(self):
        if not self.current_user:
            return
        notifs = self.db.get_notifications(self.current_user.id, 10)
        # Show notification badge
        unread = [n for n in notifs if not n.read]
        if unread:
            self.setWindowTitle(f"Zurati ({len(unread)})")

    def select_server(self, server: Server):
        # Uncheck all server buttons
        for btn in self.server_buttons.values():
            btn.setChecked(False)
        
        # Check the selected server button
        if server.id in self.server_buttons:
            self.server_buttons[server.id].setChecked(True)
        
        self.current_server = server
        self.server_name_label.setText(server.name)
        
        # Load channels
        channels = self.db.get_channels(server.id)
        self.channel_list.clear()
        
        # Group channels by type
        text_channels = [ch for ch in channels if ch.type == ChannelType.TEXT]
        voice_channels = [ch for ch in channels if ch.type == ChannelType.VOICE]
        
        if text_channels:
            self.channel_list.addItem("── TEXT CHANNELS ──")
            for ch in text_channels:
                item = QListWidgetItem(f"# {ch.name}")
                item.setData(Qt.UserRole, ch.id)
                item.setForeground(QColor("#6a6a7e"))
                self.channel_list.addItem(item)
        
        if voice_channels:
            self.channel_list.addItem("── VOICE CHANNELS ──")
            for ch in voice_channels:
                item = QListWidgetItem(f"🔊 {ch.name}")
                item.setData(Qt.UserRole, ch.id)
                item.setForeground(QColor("#6a6a7e"))
                self.channel_list.addItem(item)
        
        # Update members
        self.update_member_list()

    def on_channel_selected(self, item):
        channel_id = item.data(Qt.UserRole)
        if not channel_id:
            return
        
        # Find channel
        channels = self.db.get_channels(self.current_server.id) if self.current_server else []
        channel = next((ch for ch in channels if ch.id == channel_id), None)
        
        if channel and channel.type == ChannelType.TEXT:
            self.current_channel = channel
            self.channel_title.setText(f"# {channel.name}")
            
            # Load messages
            messages = self.db.get_messages(channel.id, 100)
            self.message_display.clear()
            
            for msg in reversed(messages):
                author = self.db.get_user(msg.author_id)
                author_name = author.display_name if author else msg.author_id
                time = datetime.fromisoformat(msg.timestamp).strftime("%I:%M %p")
                self.message_display.append(f"""
                    <div style="margin: 4px 0;">
                        <b>{author_name}</b> <span style="color: #6a6a7e; font-size: 12px;">{time}</span>
                        <div style="color: #e0e0e0; margin-left: 4px;">{msg.content}</div>
                    </div>
                """)
            
            # Scroll to bottom
            scrollbar = self.message_display.verticalScrollBar()
            scrollbar.setValue(scrollbar.maximum())

    def update_member_list(self):
        self.member_list.clear()
        if not self.current_server:
            return
        
        # Get members from server
        members = self.current_server.members
        for member_id in members:
            user = self.db.get_user(member_id)
            if user:
                status_icons = {
                    UserStatus.ONLINE: "🟢",
                    UserStatus.IDLE: "🟡",
                    UserStatus.DND: "🔴",
                    UserStatus.OFFLINE: "⚪"
                }
                status_icon = status_icons.get(user.status, "⚪")
                item = QListWidgetItem(f"{status_icon} {user.display_name}")
                item.setForeground(QColor("#a6a6b8"))
                self.member_list.addItem(item)

    def send_message(self):
        content = self.message_input.toPlainText().strip()
        if not content or not self.current_channel:
            return
        
        message = Message(
            id=str(uuid.uuid4()),
            channel_id=self.current_channel.id,
            author_id=self.current_user.id,
            content=content,
            timestamp=datetime.now().isoformat()
        )
        
        self.db.save_message(message)
        self.message_input.clear()
        
        # Display the message
        author_name = self.current_user.display_name
        time = datetime.now().strftime("%I:%M %p")
        self.message_display.append(f"""
            <div style="margin: 4px 0;">
                <b>{author_name}</b> <span style="color: #6a6a7e; font-size: 12px;">{time}</span>
                <div style="color: #e0e0e0; margin-left: 4px;">{content}</div>
            </div>
        """)
        
        scrollbar = self.message_display.verticalScrollBar()
        scrollbar.setValue(scrollbar.maximum())
        
        # Show toast notification
        ToastNotification(f"Message sent in #{self.current_channel.name}", self)

    def show_create_channel_dialog(self):
        if not self.current_server:
            ToastNotification("Select a server first", self)
            return
        
        dialog = QDialog(self)
        dialog.setWindowTitle("Create Channel")
        dialog.setFixedSize(400, 250)
        dialog.setStyleSheet(self.theme_manager.get_style())
        
        layout = QVBoxLayout(dialog)
        layout.setSpacing(12)
        
        # Channel name
        name_label = QLabel("Channel Name")
        name_label.setStyleSheet("color: #a6a6b8;")
        layout.addWidget(name_label)
        
        name_input = QLineEdit()
        name_input.setPlaceholderText("new-channel")
        name_input.setStyleSheet("""
            QLineEdit {
                background: #2a2a4a;
                border: 1px solid #3a3a5a;
                border-radius: 8px;
                padding: 8px 12px;
                color: white;
            }
        """)
        layout.addWidget(name_input)
        
        # Channel type
        type_label = QLabel("Channel Type")
        type_label.setStyleSheet("color: #a6a6b8;")
        layout.addWidget(type_label)
        
        type_combo = QComboBox()
        type_combo.addItems(["Text", "Voice"])
        type_combo.setStyleSheet("""
            QComboBox {
                background: #2a2a4a;
                border: 1px solid #3a3a5a;
                border-radius: 8px;
                padding: 8px;
                color: white;
            }
            QComboBox::drop-down {
                border: none;
            }
        """)
        layout.addWidget(type_combo)
        
        layout.addStretch()
        
        # Buttons
        btn_layout = QHBoxLayout()
        cancel_btn = QPushButton("Cancel")
        cancel_btn.setStyleSheet("""
            QPushButton {
                background: #2a2a4a;
                color: #a6a6b8;
                border: none;
                border-radius: 8px;
                padding: 8px 20px;
            }
            QPushButton:hover {
                background: #3a3a5a;
            }
        """)
        cancel_btn.clicked.connect(dialog.reject)
        btn_layout.addWidget(cancel_btn)
        
        create_btn = QPushButton("Create")
        create_btn.setObjectName("accent")
        create_btn.setStyleSheet("""
            QPushButton#accent {
                background: #6c5ce7;
                color: white;
                border: none;
                border-radius: 8px;
                padding: 8px 20px;
            }
            QPushButton#accent:hover {
                background: #7c6ce7;
            }
        """)
        create_btn.clicked.connect(lambda: self.create_channel(
            name_input.text(),
            type_combo.currentText().lower(),
            dialog
        ))
        btn_layout.addWidget(create_btn)
        
        layout.addLayout(btn_layout)
        dialog.exec()

    def create_channel(self, name: str, channel_type: str, dialog: QDialog):
        if not name or not self.current_server:
            return
        
        channel = Channel(
            id=str(uuid.uuid4()),
            name=name,
            type=ChannelType.TEXT if channel_type == "text" else ChannelType.VOICE,
            server_id=self.current_server.id,
            position=len(self.db.get_channels(self.current_server.id))
        )
        
        self.db.save_channel(channel)
        dialog.accept()
        ToastNotification(f"Channel #{name} created!", self)
        
        # Reload channels
        self.select_server(self.current_server)

    def show_dm_list(self):
        # Uncheck all server buttons
        for btn in self.server_buttons.values():
            btn.setChecked(False)
        
        self.current_server = None
        self.server_name_label.setText("Direct Messages")
        self.channel_list.clear()
        self.channel_title.setText("💬 Direct Messages")
        self.message_display.clear()
        self.message_display.append("""
            <div style="text-align: center; padding: 40px; color: #6a6a7e;">
                <div style="font-size: 48px; margin-bottom: 16px;">💬</div>
                <div style="font-size: 20px; color: white;">Direct Messages</div>
                <div style="margin-top: 8px;">Start a conversation with your friends</div>
            </div>
        """)
        self.member_list.clear()

    def show_toast(self, message: str):
        ToastNotification(message, self)

    # ============================================================
    # SETTINGS
    # ============================================================

    def open_settings(self):
        dialog = SettingsDialog(self.current_user, self.db, self.theme_manager, self)
        if dialog.exec():
            # Refresh UI
            self.apply_theme()
            self.current_user = self.db.get_user("user1")
            self.load_servers()

    # ============================================================
    # MENU BAR
    # ============================================================

    def create_menu_bar(self):
        menubar = self.menuBar()
        menubar.setStyleSheet("""
            QMenuBar {
                background: #15151e;
                color: #a6a6b8;
                border: none;
                padding: 4px;
            }
            QMenuBar::item:selected {
                background: #2a2a4a;
                color: white;
            }
            QMenu {
                background: #1a1a2e;
                color: #e0e0e0;
                border: 1px solid #2a2a4a;
                border-radius: 8px;
                padding: 4px;
            }
            QMenu::item:selected {
                background: #2a2a4a;
            }
        """)
        
        # File menu
        file_menu = menubar.addMenu("File")
        
        add_server = QAction("Create Server", self)
        add_server.triggered.connect(self.show_create_server_dialog)
        file_menu.addAction(add_server)
        
        file_menu.addSeparator()
        
        export = QAction("Export Data", self)
        export.triggered.connect(self.export_data)
        file_menu.addAction(export)
        
        import_action = QAction("Import Data", self)
        import_action.triggered.connect(self.import_data)
        file_menu.addAction(import_action)
        
        file_menu.addSeparator()
        
        quit_action = QAction("Quit", self)
        quit_action.triggered.connect(self.close)
        file_menu.addAction(quit_action)
        
        # Edit menu
        edit_menu = menubar.addMenu("Edit")
        
        settings_action = QAction("Settings", self)
        settings_action.triggered.connect(self.open_settings)
        edit_menu.addAction(settings_action)

        # View menu
        view_menu = menubar.addMenu("View")
        
        dark_theme = QAction("Dark Theme", self)
        dark_theme.triggered.connect(lambda: self.change_theme("dark"))
        view_menu.addAction(dark_theme)
        
        light_theme = QAction("Light Theme", self)
        light_theme.triggered.connect(lambda: self.change_theme("light"))
        view_menu.addAction(light_theme)
        
        amoled_theme = QAction("AMOLED Theme", self)
        amoled_theme.triggered.connect(lambda: self.change_theme("amoled"))
        view_menu.addAction(amoled_theme)

        # Help menu
        help_menu = menubar.addMenu("Help")
        
        about_action = QAction("About Zurati", self)
        about_action.triggered.connect(self.show_about)
        help_menu.addAction(about_action)

    def change_theme(self, theme_name: str):
        self.theme_manager.current_theme = theme_name
        self.db.set_setting("theme", theme_name)
        self.apply_theme()

    def show_create_server_dialog(self):
        dialog = QDialog(self)
        dialog.setWindowTitle("Create Server")
        dialog.setFixedSize(400, 250)
        dialog.setStyleSheet(self.theme_manager.get_style())
        
        layout = QVBoxLayout(dialog)
        layout.setSpacing(12)
        
        name_label = QLabel("Server Name")
        name_label.setStyleSheet("color: #a6a6b8;")
        layout.addWidget(name_label)
        
        name_input = QLineEdit()
        name_input.setPlaceholderText("My Server")
        name_input.setStyleSheet("""
            QLineEdit {
                background: #2a2a4a;
                border: 1px solid #3a3a5a;
                border-radius: 8px;
                padding: 8px 12px;
                color: white;
            }
        """)
        layout.addWidget(name_input)
        
        icon_label = QLabel("Server Icon (emoji)")
        icon_label.setStyleSheet("color: #a6a6b8;")
        layout.addWidget(icon_label)
        
        icon_input = QLineEdit()
        icon_input.setPlaceholderText("🏠")
        icon_input.setMaxLength(2)
        icon_input.setStyleSheet("""
            QLineEdit {
                background: #2a2a4a;
                border: 1px solid #3a3a5a;
                border-radius: 8px;
                padding: 8px 12px;
                color: white;
                font-size: 24px;
            }
        """)
        layout.addWidget(icon_input)
        
        layout.addStretch()
        
        btn_layout = QHBoxLayout()
        cancel_btn = QPushButton("Cancel")
        cancel_btn.setStyleSheet("""
            QPushButton {
                background: #2a2a4a;
                color: #a6a6b8;
                border: none;
                border-radius: 8px;
                padding: 8px 20px;
            }
            QPushButton:hover {
                background: #3a3a5a;
            }
        """)
        cancel_btn.clicked.connect(dialog.reject)
        btn_layout.addWidget(cancel_btn)
        
        create_btn = QPushButton("Create")
        create_btn.setObjectName("accent")
        create_btn.setStyleSheet("""
            QPushButton#accent {
                background: #6c5ce7;
                color: white;
                border: none;
                border-radius: 8px;
                padding: 8px 20px;
            }
            QPushButton#accent:hover {
                background: #7c6ce7;
            }
        """)
        create_btn.clicked.connect(lambda: self.create_server(
            name_input.text(),
            icon_input.text() or "🏠",
            dialog
        ))
        btn_layout.addWidget(create_btn)
        
        layout.addLayout(btn_layout)
        dialog.exec()

    def create_server(self, name: str, icon: str, dialog: QDialog):
        if not name:
            return
        
        server = Server(
            id=str(uuid.uuid4()),
            name=name,
            icon=icon,
            owner_id=self.current_user.id,
            created_at=datetime.now().isoformat(),
            members=[self.current_user.id]
        )
        
        self.db.save_server(server)
        
        # Create default channel
        channel = Channel(
            id=str(uuid.uuid4()),
            name="general",
            type=ChannelType.TEXT,
            server_id=server.id,
            position=0
        )
        self.db.save_channel(channel)
        
        dialog.accept()
        ToastNotification(f"Server {name} created!", self)
        self.load_servers()

    def export_data(self):
        path = QFileDialog.getSaveFileName(self, "Export Data", "zurati_export.json", "JSON Files (*.json)")
        if path[0]:
            try:
                # Export all data
                data = {
                    "users": [asdict(u) for u in self.db.get_all_users()],
                    "servers": [asdict(s) for s in self.db.get_all_servers()],
                    "exported_at": datetime.now().isoformat()
                }
                with open(path[0], 'w') as f:
                    json.dump(data, f, indent=2)
                ToastNotification("Data exported successfully!", self)
            except Exception as e:
                ToastNotification(f"Export failed: {str(e)}", self)

    def import_data(self):
        path = QFileDialog.getOpenFileName(self, "Import Data", "", "JSON Files (*.json)")
        if path[0]:
            try:
                with open(path[0], 'r') as f:
                    data = json.load(f)
                ToastNotification("Data imported successfully!", self)
            except Exception as e:
                ToastNotification(f"Import failed: {str(e)}", self)

    def show_about(self):
        dialog = QDialog(self)
        dialog.setWindowTitle("About Zurati")
        dialog.setFixedSize(400, 300)
        dialog.setStyleSheet(self.theme_manager.get_style())
        
        layout = QVBoxLayout(dialog)
        layout.setAlignment(Qt.AlignCenter)
        layout.setSpacing(16)
        
        logo = QLabel("⚡")
        logo.setStyleSheet("font-size: 64px;")
        layout.addWidget(logo, alignment=Qt.AlignCenter)
        
        title = QLabel("ZURATI")
        title.setStyleSheet("font-size: 28px; font-weight: bold; color: white;")
        layout.addWidget(title, alignment=Qt.AlignCenter)
        
        version = QLabel("Version 1.0.0")
        version.setStyleSheet("color: #6a6a7e; font-size: 14px;")
        layout.addWidget(version, alignment=Qt.AlignCenter)
        
        owned = QLabel("Owned by kone / zaden")
        owned.setStyleSheet("color: #a6a6b8; font-size: 14px;")
        layout.addWidget(owned, alignment=Qt.AlignCenter)
        
        desc = QLabel(
            "A modern communication platform built with ❤️\n"
            "Featuring real-time messaging, voice channels,\n"
            "and a premium experience."
        )
        desc.setStyleSheet("color: #a6a6b8; font-size: 13px; text-align: center;")
        desc.setAlignment(Qt.AlignCenter)
        layout.addWidget(desc)
        
        close_btn = QPushButton("Close")
        close_btn.setObjectName("accent")
        close_btn.setStyleSheet("""
            QPushButton#accent {
                background: #6c5ce7;
                color: white;
                border: none;
                border-radius: 8px;
                padding: 8px 40px;
            }
            QPushButton#accent:hover {
                background: #7c6ce7;
            }
        """)
        close_btn.clicked.connect(dialog.accept)
        layout.addWidget(close_btn, alignment=Qt.AlignCenter)
        
        dialog.exec()

# ============================================================================
# SETTINGS DIALOG
# ============================================================================

class SettingsDialog(QDialog):
    def __init__(self, user: User, db: DatabaseManager, theme_manager: ThemeManager, parent=None):
        super().__init__(parent)
        self.user = user
        self.db = db
        self.theme_manager = theme_manager
        self.setWindowTitle("Settings")
        self.setMinimumSize(800, 600)
        self.setStyleSheet(theme_manager.get_style())
        
        self.init_ui()
        self.load_settings()

    def init_ui(self):
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        
        # Sidebar
        sidebar = QListWidget()
        sidebar.setFixedWidth(200)
        sidebar.setStyleSheet("""
            QListWidget {
                background: #15151e;
                border: none;
                padding: 8px;
            }
            QListWidget::item {
                padding: 12px 16px;
                color: #a6a6b8;
                border-radius: 8px;
            }
            QListWidget::item:hover {
                background: #2a2a4a;
                color: white;
            }
            QListWidget::item:selected {
                background: #2d2d44;
                color: white;
            }
        """)
        
        items = [
            "👤 Profile",
            "🎨 Appearance",
            "🔔 Notifications",
            "🔒 Privacy",
            "⭐ Premium",
            "⌨️ Keybinds",
            "ℹ️ About"
        ]
        sidebar.addItems(items)
        sidebar.currentRowChanged.connect(self.switch_panel)
        layout.addWidget(sidebar)
        
        # Content area
        self.content_area = QStackedWidget()
        self.content_area.setStyleSheet("""
            QWidget {
                background: #1a1a2e;
                padding: 20px;
            }
        """)
        
        self.profile_panel = self.create_profile_panel()
        self.appearance_panel = self.create_appearance_panel()
        self.notification_panel = self.create_notification_panel()
        self.privacy_panel = self.create_privacy_panel()
        self.premium_panel = self.create_premium_panel()
        self.keybind_panel = self.create_keybind_panel()
        self.about_panel = self.create_about_panel()
        
        self.content_area.addWidget(self.profile_panel)
        self.content_area.addWidget(self.appearance_panel)
        self.content_area.addWidget(self.notification_panel)
        self.content_area.addWidget(self.privacy_panel)
        self.content_area.addWidget(self.premium_panel)
        self.content_area.addWidget(self.keybind_panel)
        self.content_area.addWidget(self.about_panel)
        
        layout.addWidget(self.content_area, 1)

    def create_profile_panel(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setSpacing(16)
        
        title = QLabel("Profile Settings")
        title.setStyleSheet("font-size: 20px; font-weight: bold; color: white;")
        layout.addWidget(title)
        
        # Username
        username_label = QLabel("Username")
        username_label.setStyleSheet("color: #a6a6b8;")
        layout.addWidget(username_label)
        
        self.username_input = QLineEdit()
        self.username_input.setStyleSheet("""
            QLineEdit {
                background: #2a2a4a;
                border: 1px solid #3a3a5a;
                border-radius: 8px;
                padding: 10px 14px;
                color: white;
            }
        """)
        layout.addWidget(self.username_input)
        
        # Display name
        display_label = QLabel("Display Name")
        display_label.setStyleSheet("color: #a6a6b8;")
        layout.addWidget(display_label)
        
        self.display_input = QLineEdit()
        self.display_input.setStyleSheet("""
            QLineEdit {
                background: #2a2a4a;
                border: 1px solid #3a3a5a;
                border-radius: 8px;
                padding: 10px 14px;
                color: white;
            }
        """)
        layout.addWidget(self.display_input)
        
        # Status
        status_label = QLabel("Status")
        status_label.setStyleSheet("color: #a6a6b8;")
        layout.addWidget(status_label)
        
        self.status_combo = QComboBox()
        self.status_combo.addItems(["Online", "Idle", "Do Not Disturb", "Offline"])
        self.status_combo.setStyleSheet("""
            QComboBox {
                background: #2a2a4a;
                border: 1px solid #3a3a5a;
                border-radius: 8px;
                padding: 8px 12px;
                color: white;
            }
            QComboBox::drop-down {
                border: none;
            }
        """)
        layout.addWidget(self.status_combo)
        
        # Status text
        status_text_label = QLabel("Status Text")
        status_text_label.setStyleSheet("color: #a6a6b8;")
        layout.addWidget(status_text_label)
        
        self.status_text_input = QLineEdit()
        self.status_text_input.setPlaceholderText("What's on your mind?")
        self.status_text_input.setStyleSheet("""
            QLineEdit {
                background: #2a2a4a;
                border: 1px solid #3a3a5a;
                border-radius: 8px;
                padding: 10px 14px;
                color: white;
            }
        """)
        layout.addWidget(self.status_text_input)
        
        layout.addStretch()
        
        # Save button
        save_btn = QPushButton("Save Changes")
        save_btn.setObjectName("accent")
        save_btn.setStyleSheet("""
            QPushButton#accent {
                background: #6c5ce7;
                color: white;
                border: none;
                border-radius: 8px;
                padding: 12px;
                font-weight: bold;
            }
            QPushButton#accent:hover {
                background: #7c6ce7;
            }
        """)
        save_btn.clicked.connect(self.save_profile)
        layout.addWidget(save_btn)
        
        return panel

    def create_appearance_panel(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setSpacing(16)
        
        title = QLabel("Appearance")
        title.setStyleSheet("font-size: 20px; font-weight: bold; color: white;")
        layout.addWidget(title)
        
        # Theme
        theme_label = QLabel("Theme")
        theme_label.setStyleSheet("color: #a6a6b8;")
        layout.addWidget(theme_label)
        
        self.theme_combo = QComboBox()
        self.theme_combo.addItems(["Dark", "Light", "AMOLED"])
        self.theme_combo.setStyleSheet("""
            QComboBox {
                background: #2a2a4a;
                border: 1px solid #3a3a5a;
                border-radius: 8px;
                padding: 8px 12px;
                color: white;
            }
            QComboBox::drop-down {
                border: none;
            }
        """)
        layout.addWidget(self.theme_combo)
        
        # Accent color
        accent_label = QLabel("Accent Color")
        accent_label.setStyleSheet("color: #a6a6b8;")
        layout.addWidget(accent_label)
        
        accent_layout = QHBoxLayout()
        self.accent_colors = [
            "#6c5ce7", "#00b894", "#fdcb6e", "#ff6b6b", 
            "#45b7d1", "#e17055", "#00cec9", "#fd79a8"
        ]
        self.accent_buttons = []
        for color in self.accent_colors:
            btn = QPushButton()
            btn.setFixedSize(32, 32)
            btn.setStyleSheet(f"""
                QPushButton {{
                    background: {color};
                    border: 2px solid transparent;
                    border-radius: 16px;
                }}
                QPushButton:checked {{
                    border: 2px solid white;
                }}
            """)
            btn.setCheckable(True)
            btn.clicked.connect(lambda checked, c=color: self.select_accent(c))
            accent_layout.addWidget(btn)
            self.accent_buttons.append(btn)
        
        accent_layout.addStretch()
        layout.addLayout(accent_layout)
        
        layout.addStretch()
        
        # Apply button
        apply_btn = QPushButton("Apply Theme")
        apply_btn.setObjectName("accent")
        apply_btn.setStyleSheet("""
            QPushButton#accent {
                background: #6c5ce7;
                color: white;
                border: none;
                border-radius: 8px;
                padding: 12px;
                font-weight: bold;
            }
            QPushButton#accent:hover {
                background: #7c6ce7;
            }
        """)
        apply_btn.clicked.connect(self.apply_appearance)
        layout.addWidget(apply_btn)
        
        return panel

    def create_notification_panel(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setSpacing(16)
        
        title = QLabel("Notifications")
        title.setStyleSheet("font-size: 20px; font-weight: bold; color: white;")
        layout.addWidget(title)
        
        # Toggle switches
        toggles = [
            ("Enable Notifications", "notifications_enabled"),
            ("Sound on Messages", "sound_enabled"),
            ("Desktop Notifications", "desktop_notifications"),
            ("Show Preview in Notifications", "preview_enabled"),
        ]
        
        self.notification_toggles = {}
        for label_text, key in toggles:
            widget = QWidget()
            widget_layout = QHBoxLayout(widget)
            widget_layout.setContentsMargins(0, 8, 0, 8)
            
            label = QLabel(label_text)
            label.setStyleSheet("color: #e0e0e0;")
            widget_layout.addWidget(label)
            widget_layout.addStretch()
            
            toggle = QCheckBox()
            toggle.setStyleSheet("""
                QCheckBox::indicator {
                    width: 20px;
                    height: 20px;
                    border-radius: 10px;
                }
                QCheckBox::indicator:checked {
                    background: #6c5ce7;
                }
            """)
            widget_layout.addWidget(toggle)
            self.notification_toggles[key] = toggle
            
            layout.addWidget(widget)
        
        layout.addStretch()
        
        # Save button
        save_btn = QPushButton("Save Notification Settings")
        save_btn.setObjectName("accent")
        save_btn.setStyleSheet("""
            QPushButton#accent {
                background: #6c5ce7;
                color: white;
                border: none;
                border-radius: 8px;
                padding: 12px;
                font-weight: bold;
            }
            QPushButton#accent:hover {
                background: #7c6ce7;
            }
        """)
        save_btn.clicked.connect(self.save_notifications)
        layout.addWidget(save_btn)
        
        return panel

    def create_privacy_panel(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setSpacing(16)
        
        title = QLabel("Privacy & Security")
        title.setStyleSheet("font-size: 20px; font-weight: bold; color: white;")
        layout.addWidget(title)
        
        # Privacy options
        options = [
            ("Show Online Status", "show_status"),
            ("Allow Direct Messages", "allow_dms"),
            ("Show Read Receipts", "read_receipts"),
            ("Allow Friend Requests", "allow_friend_requests"),
        ]
        
        self.privacy_toggles = {}
        for label_text, key in options:
            widget = QWidget()
            widget_layout = QHBoxLayout(widget)
            widget_layout.setContentsMargins(0, 8, 0, 8)
            
            label = QLabel(label_text)
            label.setStyleSheet("color: #e0e0e0;")
            widget_layout.addWidget(label)
            widget_layout.addStretch()
            
            toggle = QCheckBox()
            toggle.setStyleSheet("""
                QCheckBox::indicator {
                    width: 20px;
                    height: 20px;
                    border-radius: 10px;
                }
                QCheckBox::indicator:checked {
                    background: #6c5ce7;
                }
            """)
            widget_layout.addWidget(toggle)
            self.privacy_toggles[key] = toggle
            
            layout.addWidget(widget)
        
        layout.addStretch()
        
        # Save button
        save_btn = QPushButton("Save Privacy Settings")
        save_btn.setObjectName("accent")
        save_btn.setStyleSheet("""
            QPushButton#accent {
                background: #6c5ce7;
                color: white;
                border: none;
                border-radius: 8px;
                padding: 12px;
                font-weight: bold;
            }
            QPushButton#accent:hover {
                background: #7c6ce7;
            }
        """)
        save_btn.clicked.connect(self.save_privacy)
        layout.addWidget(save_btn)
        
        return panel

    def create_premium_panel(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setSpacing(16)
        
        title = QLabel("Zurati Premium")
        title.setStyleSheet("font-size: 20px; font-weight: bold; color: white;")
        layout.addWidget(title)
        
        # Premium status
        status_widget = QWidget()
        status_widget.setStyleSheet("""
            QWidget {
                background: #2a2a4a;
                border-radius: 12px;
                padding: 16px;
            }
        """)
        status_layout = QHBoxLayout(status_widget)
        
        badge = QLabel("⭐")
        badge.setStyleSheet("font-size: 32px;")
        status_layout.addWidget(badge)
        
        if self.user.is_premium:
            status_text = QLabel("You have Zurati Premium!")
            status_text.setStyleSheet("color: #fdcb6e; font-size: 16px; font-weight: bold;")
            status_layout.addWidget(status_text)
        else:
            status_text = QLabel("Upgrade to Zurati Premium")
            status_text.setStyleSheet("color: #a6a6b8; font-size: 16px;")
            status_layout.addWidget(status_text)
        
        status_layout.addStretch()
        layout.addWidget(status_widget)
        
        # Premium features
        features = [
            ("🎨", "Exclusive Themes", "Access to premium themes and custom colors"),
            ("🎵", "Custom Status Animations", "Animated status effects"),
            ("📈", "Larger Uploads", "Upload files up to 100MB"),
            ("👑", "Premium Badge", "Show off your premium status"),
            ("🎭", "Custom Profile Decorations", "Animated profile effects"),
        ]
        
        for icon, name, desc in features:
            feature_widget = QWidget()
            feature_widget.setStyleSheet("""
                QWidget {
                    background: #2a2a4a;
                    border-radius: 8px;
                    padding: 12px;
                }
            """)
            feature_layout = QHBoxLayout(feature_widget)
            
            icon_label = QLabel(icon)
            icon_label.setStyleSheet("font-size: 20px;")
            feature_layout.addWidget(icon_label)
            
            text_layout = QVBoxLayout()
            name_label = QLabel(name)
            name_label.setStyleSheet("color: white; font-weight: bold;")
            text_layout.addWidget(name_label)
            
            desc_label = QLabel(desc)
            desc_label.setStyleSheet("color: #6a6a7e; font-size: 12px;")
            text_layout.addWidget(desc_label)
            
            feature_layout.addLayout(text_layout)
            feature_layout.addStretch()
            
            layout.addWidget(feature_widget)
        
        layout.addStretch()
        
        # Premium button
        if not self.user.is_premium:
            premium_btn = QPushButton("✨ Upgrade to Premium")
            premium_btn.setObjectName("accent")
            premium_btn.setStyleSheet("""
                QPushButton#accent {
                    background: #fdcb6e;
                    color: #2d2d2d;
                    border: none;
                    border-radius: 8px;
                    padding: 14px;
                    font-weight: bold;
                    font-size: 16px;
                }
                QPushButton#accent:hover {
                    background: #ffeaa7;
                }
            """)
            premium_btn.clicked.connect(self.upgrade_premium)
            layout.addWidget(premium_btn)
        
        return panel

    def create_keybind_panel(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setSpacing(16)
        
        title = QLabel("Keyboard Shortcuts")
        title.setStyleSheet("font-size: 20px; font-weight: bold; color: white;")
        layout.addWidget(title)
        
        shortcuts = [
            ("Send Message", "Enter"),
            ("New Line", "Shift + Enter"),
            ("Search", "Ctrl + K"),
            ("Settings", "Ctrl + ,"),
            ("Quit", "Ctrl + Q"),
        ]
        
        for action, key in shortcuts:
            widget = QWidget()
            widget.setStyleSheet("""
                QWidget {
                    background: #2a2a4a;
                    border-radius: 8px;
                    padding: 8px 12px;
                }
            """)
            widget_layout = QHBoxLayout(widget)
            
            action_label = QLabel(action)
            action_label.setStyleSheet("color: #e0e0e0;")
            widget_layout.addWidget(action_label)
            
            widget_layout.addStretch()
            
            key_label = QLabel(key)
            key_label.setStyleSheet("""
                color: #6c5ce7;
                font-weight: bold;
                background: #1a1a2e;
                padding: 4px 12px;
                border-radius: 4px;
                font-family: monospace;
            """)
            widget_layout.addWidget(key_label)
            
            layout.addWidget(widget)
        
        layout.addStretch()
        
        return panel

    def create_about_panel(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setAlignment(Qt.AlignCenter)
        layout.setSpacing(16)
        
        logo = QLabel("⚡")
        logo.setStyleSheet("font-size: 64px;")
        layout.addWidget(logo, alignment=Qt.AlignCenter)
        
        title = QLabel("ZURATI")
        title.setStyleSheet("font-size: 28px; font-weight: bold; color: white;")
        layout.addWidget(title, alignment=Qt.AlignCenter)
        
        version = QLabel("Version 1.0.0")
        version.setStyleSheet("color: #6a6a7e; font-size: 14px;")
        layout.addWidget(version, alignment=Qt.AlignCenter)
        
        owner = QLabel("Owned by kone / zaden")
        owner.setStyleSheet("color: #a6a6b8; font-size: 14px;")
        layout.addWidget(owner, alignment=Qt.AlignCenter)
        
        desc = QLabel(
            "Built with ❤️ using Python and PySide6\n"
            "A modern communication platform for everyone."
        )
        desc.setStyleSheet("color: #a6a6b8; font-size: 13px; text-align: center;")
        desc.setAlignment(Qt.AlignCenter)
        layout.addWidget(desc)
        
        layout.addStretch()
        
        return panel

    def load_settings(self):
        # Load user data
        self.username_input.setText(self.user.username)
        self.display_input.setText(self.user.display_name)
        self.status_combo.setCurrentIndex([UserStatus.ONLINE, UserStatus.IDLE, UserStatus.DND, UserStatus.OFFLINE].index(self.user.status))
        self.status_text_input.setText(self.user.status_text)
        
        # Load theme
        theme = self.db.get_setting("theme", "dark")
        self.theme_combo.setCurrentIndex(["dark", "light", "amoled"].index(theme))
        
        # Load notification settings
        for key in self.notification_toggles:
            val = self.db.get_setting(key, "true") == "true"
            self.notification_toggles[key].setChecked(val)
        
        # Load privacy settings
        for key in self.privacy_toggles:
            val = self.db.get_setting(key, "true") == "true"
            self.privacy_toggles[key].setChecked(val)

    def save_profile(self):
        self.user.username = self.username_input.text()
        self.user.display_name = self.display_input.text()
        status_map = ["online", "idle", "dnd", "offline"]
        self.user.status = UserStatus(status_map[self.status_combo.currentIndex()])
        self.user.status_text = self.status_text_input.text()
        
        self.db.save_user(self.user)
        ToastNotification("Profile updated!", self)

    def select_accent(self, color: str):
        for btn in self.accent_buttons:
            btn.setChecked(btn.styleSheet().find(color) != -1)
        self.theme_manager.accent_color = color
        self.db.set_setting("accent_color", color)

    def apply_appearance(self):
        theme_map = {"Dark": "dark", "Light": "light", "AMOLED": "amoled"}
        theme = theme_map[self.theme_combo.currentText()]
        self.theme_manager.current_theme = theme
        self.db.set_setting("theme", theme)
        self.setStyleSheet(self.theme_manager.get_style())
        ToastNotification("Theme applied!", self)

    def save_notifications(self):
        for key, toggle in self.notification_toggles.items():
            self.db.set_setting(key, str(toggle.isChecked()).lower())
        ToastNotification("Notification settings saved!", self)

    def save_privacy(self):
        for key, toggle in self.privacy_toggles.items():
            self.db.set_setting(key, str(toggle.isChecked()).lower())
        ToastNotification("Privacy settings saved!", self)

    def upgrade_premium(self):
        self.user.is_premium = True
        self.db.save_user(self.user)
        ToastNotification("✨ You are now a Zurati Premium member!", self)
        self.accept()

    def switch_panel(self, index: int):
        self.content_area.setCurrentIndex(index)

# ============================================================================
# APPLICATION ENTRY POINT
# ============================================================================

def main():
    app = QApplication(sys.argv)
    app.setStyle('Fusion')
    app.setApplicationName("Zurati")
    app.setOrganizationName("kone")
    app.setOrganizationDomain("zurati.local")
    
    # Set default font
    font = QFont("Segoe UI", 10)
    app.setFont(font)
    
    window = ZuratiApp()
    window.create_menu_bar()
    window.show()
    
    sys.exit(app.exec())

if __name__ == '__main__':
    main()
