#!/bin/bash

# remove broken config
sudo rm -f /etc/apt/sources.list.d/microsoft-prod.list

# install Microsoft repo the official way
curl -fsSLO https://packages.microsoft.com/config/ubuntu/24.04/packages-microsoft-prod.deb
sudo dpkg -i packages-microsoft-prod.deb
rm -f packages-microsoft-prod.deb

# update + install sqlcmd
sudo apt update
sudo ACCEPT_EULA=Y apt install -y mssql-tools18 unixodbc-dev

# add to PATH
echo 'export PATH="$PATH:/opt/mssql-tools18/bin"' >> ~/.bashrc
source ~/.bashrc
