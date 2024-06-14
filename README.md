Certainly! Here's the complete README content with all sections and commands in a single markdown code block for easy copying:

```markdown
# Supplier Categorization ML Python

This project categorizes suppliers based on company names and URLs from a CSV file, determining whether each is a service or supplier and categorizing products.

## Overview

The Supplier Categorization ML Python project automates supplier categorization based on company data provided in a CSV file. It uses machine learning techniques to classify companies as either service providers or suppliers and categorizes their products into different levels.

## Features

- **Supplier Classification**: Automatically identifies if a company is a service provider or a supplier.
- **Product Categorization**: Categorizes products offered by each company into various levels.
- **API Integration**: Provides endpoints for uploading CSV files and retrieving processed company data.

## Installation

### Prerequisites

- Python 3.8+
- pip

### Setup

Clone the repository and navigate to the project directory:
```bash
git clone https://github.com/username/supplier-categorization-ml-python.git
cd supplier-categorization-ml-python
```

(Optional) Set up a virtual environment:
```bash
python3 -m venv venv
source venv/bin/activate  # On Windows use `venv\Scripts\activate`
```

Install dependencies:
```bash
pip install -r requirements.txt
```

## Usage

### Running the Application

To start the application:
```bash
python main.py
```

### API Endpoints

The application exposes the following endpoints:

#### POST /upload

Uploads a CSV file with company names and URLs for processing.

```bash
curl -X POST -F "file=@companies.csv" http://localhost:8000/upload
```

#### POST /omnichannel_mapping

Uploads an omnichannel mapping file for processing.

```bash
curl -X POST -F "file=@omnichannel_mapping.csv" http://localhost:8000/omnichannel_mapping
```

#### GET /company-data

Retrieves processed company data including type (service or supplier) and product levels.

```bash
curl http://localhost:8000/company-data
```

Replace `http://localhost:8000` with your server's base URL if deploying elsewhere.

## Contributing

Contributions are welcome! Please follow GitHub Flow when contributing.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
```

This format includes all sections in a single markdown code block, making it straightforward to copy and paste into your `README.md` file. Adjust URLs, commands, and other details as per your specific project requirements.
